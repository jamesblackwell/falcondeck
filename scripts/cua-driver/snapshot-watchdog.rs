//! A native-thread deadline for browser snapshots, including non-yielding Rust work.
//! Other tools (notably browser consent and recording) have no deadline here.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender},
        OnceLock,
    },
    time::{Duration, Instant},
};

const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(120);
pub(crate) const STALLED_SNAPSHOT_EXIT: i32 = 75;
static WATCHDOG: OnceLock<Result<Sender<Event>, std::io::Error>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

enum Event {
    Started(u64, Instant),
    Finished(u64),
}

pub(crate) struct SnapshotDeadline {
    sender: Sender<Event>,
    id: u64,
}

impl SnapshotDeadline {
    pub(crate) fn for_tool(tool: &str) -> Result<Option<Self>, String> {
        if tool != "get_browser_state" {
            return Ok(None);
        }
        let sender = WATCHDOG.get_or_init(|| {
            let (sender, receiver) = mpsc::channel();
            std::thread::Builder::new()
                .name("snapshot-deadline".into())
                .spawn(move || {
                    monitor(receiver, || {
                        eprintln!("[cua-driver] browser snapshot exceeded 120 seconds; stopping stalled helper");
                        std::process::exit(STALLED_SNAPSHOT_EXIT);
                    });
                })
                .map(|_| sender)
        });
        let sender = sender
            .as_ref()
            .map_err(|error| format!("could not start browser snapshot watchdog: {error}"))?;
        Self::start(sender.clone(), SNAPSHOT_TIMEOUT).map(Some)
    }

    fn start(sender: Sender<Event>, limit: Duration) -> Result<Self, String> {
        let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
        sender
            .send(Event::Started(id, Instant::now() + limit))
            .map_err(|_| "browser snapshot watchdog stopped".to_owned())?;
        Ok(Self { sender, id })
    }
}

impl Drop for SnapshotDeadline {
    fn drop(&mut self) {
        let _ = self.sender.send(Event::Finished(self.id));
    }
}

fn monitor(receiver: Receiver<Event>, on_expiry: impl FnOnce()) {
    let mut pending = HashMap::<u64, Instant>::new();
    loop {
        // No polling or wakeups between snapshots. Completed requests are
        // removed independently, so new calls cannot extend an older deadline.
        let event = match pending.values().min().copied() {
            Some(deadline) => {
                match receiver.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                    Ok(event) => event,
                    Err(RecvTimeoutError::Timeout) => {
                        on_expiry();
                        return;
                    }
                    Err(RecvTimeoutError::Disconnected) => return,
                }
            }
            None => match receiver.recv() {
                Ok(event) => event,
                Err(_) => return,
            },
        };
        match event {
            Event::Started(id, deadline) => {
                pending.insert(id, deadline);
            }
            Event::Finished(id) => {
                pending.remove(&id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watched() -> (Sender<Event>, Receiver<()>, std::thread::JoinHandle<()>) {
        let (sender, receiver) = mpsc::channel();
        let (expired, result) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            monitor(receiver, || {
                let _ = expired.send(());
            })
        });
        (sender, result, worker)
    }

    #[test]
    fn completed_and_cancelled_snapshots_do_not_expire() {
        let (sender, result, worker) = watched();
        for _ in 0..50 {
            drop(SnapshotDeadline::start(sender.clone(), Duration::from_millis(20)).unwrap());
        }
        assert!(matches!(
            result.recv_timeout(Duration::from_millis(80)),
            Err(RecvTimeoutError::Timeout)
        ));
        drop(sender);
        worker.join().unwrap();
    }

    #[test]
    fn newer_requests_do_not_extend_a_stalled_snapshot() {
        let (sender, result, worker) = watched();
        let stalled = SnapshotDeadline::start(sender.clone(), Duration::from_millis(40)).unwrap();
        let newer = SnapshotDeadline::start(sender.clone(), Duration::from_secs(10)).unwrap();
        result.recv_timeout(Duration::from_secs(2)).unwrap();
        drop((stalled, newer, sender));
        worker.join().unwrap();
    }

    #[test]
    fn finishing_one_request_does_not_cancel_another_deadline() {
        let (sender, result, worker) = watched();
        let first = SnapshotDeadline::start(sender.clone(), Duration::from_secs(10)).unwrap();
        let second = SnapshotDeadline::start(sender.clone(), Duration::from_millis(40)).unwrap();
        drop(first);
        result.recv_timeout(Duration::from_secs(2)).unwrap();
        drop((second, sender));
        worker.join().unwrap();
    }

    #[test]
    fn consent_and_long_running_actions_are_not_limited() {
        for tool in [
            "browser_prepare",
            "start_recording",
            "stop_recording",
            "click",
            "wait",
        ] {
            assert!(SnapshotDeadline::for_tool(tool).unwrap().is_none());
        }
    }

    #[test]
    fn non_cooperative_snapshot_child() {
        if std::env::var_os("FALCONDECK_WATCHDOG_TEST_CHILD").is_none() {
            return;
        }
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || monitor(receiver, || std::process::exit(STALLED_SNAPSHOT_EXIT)));
        let _stalled = SnapshotDeadline::start(sender, Duration::from_millis(40)).unwrap();
        loop {
            std::hint::spin_loop();
        }
    }

    #[test]
    fn deadline_stops_non_yielding_work_in_a_real_process() {
        let module = module_path!().split_once("::").unwrap().1;
        let child_test = format!("{module}::non_cooperative_snapshot_child");
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", &child_test])
            .env("FALCONDECK_WATCHDOG_TEST_CHILD", "1")
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert_eq!(status.code(), Some(STALLED_SNAPSHOT_EXIT));
                break;
            }
            if Instant::now() >= deadline {
                child.kill().unwrap();
                child.wait().unwrap();
                panic!("snapshot watchdog did not stop non-yielding work");
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

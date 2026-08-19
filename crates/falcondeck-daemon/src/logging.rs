//! Daemon logging sink.
//!
//! The daemon runs *embedded* inside the desktop app, where stdout goes
//! nowhere: a `tracing` subscriber installed only on the standalone binary's
//! path meant every diagnostic the packaged app produced was discarded, and a
//! wedged turn left no evidence behind at all. Logging therefore has to be
//! installed where both entry points pass (`spawn_embedded`) and has to land
//! in a file next to the daemon state, so a failure can be read after the
//! fact instead of reproduced.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use tracing_subscriber::EnvFilter;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// Rotated once it would otherwise grow without bound. A single generation of
/// history is enough to cover "it wedged, I restarted, what happened before?".
const MAX_LOG_BYTES: u64 = 8 * 1024 * 1024;

const DEFAULT_FILTER: &str = "falcondeck_daemon=info,tower_http=info";

/// A file handle shared by the writer that `tracing` clones per event.
#[derive(Clone)]
struct SharedFile(Arc<Mutex<File>>);

impl Write for SharedFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        // A poisoned lock still holds a usable handle: losing logs is worse
        // than the panic that poisoned it.
        let mut file = self.0.lock().unwrap_or_else(|error| error.into_inner());
        file.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        let mut file = self.0.lock().unwrap_or_else(|error| error.into_inner());
        file.flush()
    }
}

impl<'a> MakeWriter<'a> for SharedFile {
    type Writer = SharedFile;

    fn make_writer(&'a self) -> Self::Writer {
        self.clone()
    }
}

/// Log file that accompanies `state_path` (`~/.falcondeck/logs/daemon.log`).
pub fn log_path_for_state(state_path: &Path) -> PathBuf {
    state_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("logs")
        .join("daemon.log")
}

fn open_log_file(path: &Path) -> io::Result<File> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Rotation happens at open time rather than per write: the daemon is
    // long-lived but restarts often enough in practice, and a size check on
    // every event would sit in the turn-streaming hot path.
    if std::fs::metadata(path).is_ok_and(|meta| meta.len() >= MAX_LOG_BYTES) {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
    OpenOptions::new().create(true).append(true).open(path)
}

/// Installs the process-wide subscriber, logging to stderr and to a file
/// beside the daemon state. Safe to call more than once — the first call wins,
/// later ones are no-ops, which is what lets both entry points call it.
///
/// `FALCONDECK_LOG` (falling back to `RUST_LOG`) overrides the filter, so a
/// verbose session is `FALCONDECK_LOG=falcondeck_daemon=debug` with no rebuild.
pub fn init(state_path: &Path) -> Option<PathBuf> {
    let filter = std::env::var("FALCONDECK_LOG")
        .or_else(|_| std::env::var("RUST_LOG"))
        .unwrap_or_else(|_| DEFAULT_FILTER.to_string());
    let env_filter = EnvFilter::try_new(&filter).unwrap_or_else(|_| EnvFilter::new(DEFAULT_FILTER));

    let path = log_path_for_state(state_path);
    let file = match open_log_file(&path) {
        Ok(file) => Some(file),
        Err(error) => {
            // Never fail startup over logging; stderr still works.
            eprintln!(
                "falcondeck: could not open log file {}: {error}",
                path.display()
            );
            None
        }
    };

    let stderr_layer = tracing_subscriber::fmt::layer()
        .with_writer(io::stderr)
        .with_target(true);

    let installed = match file {
        Some(file) => {
            let writer = SharedFile(Arc::new(Mutex::new(file)));
            let file_layer = tracing_subscriber::fmt::layer()
                .with_writer(writer)
                // No ANSI escapes in a file that agents and humans will grep.
                .with_ansi(false)
                .with_target(true);
            tracing_subscriber::registry()
                .with(env_filter)
                .with(stderr_layer)
                .with(file_layer)
                .try_init()
                .is_ok()
        }
        None => tracing_subscriber::registry()
            .with(env_filter)
            .with(stderr_layer)
            .try_init()
            .is_ok(),
    };

    if installed {
        tracing::info!(log_file = %path.display(), filter = %filter, "daemon logging started");
        Some(path)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn log_file_sits_beside_the_daemon_state() {
        assert_eq!(
            log_path_for_state(Path::new("/Users/x/.falcondeck/daemon-state.json")),
            PathBuf::from("/Users/x/.falcondeck/logs/daemon.log")
        );
    }

    #[test]
    fn oversized_logs_rotate_on_open() {
        let dir = std::env::temp_dir().join(format!("fd-log-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("logs").join("daemon.log");

        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, vec![b'x'; (MAX_LOG_BYTES + 1) as usize]).unwrap();
        open_log_file(&path).unwrap();

        // The oversized file moved aside and the live log restarted empty.
        assert!(path.with_extension("log.1").exists());
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

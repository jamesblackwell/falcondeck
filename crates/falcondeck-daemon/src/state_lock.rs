//! Cross-process ownership of a daemon's persisted state directory.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::DaemonError;

/// Closing the file releases the advisory lock, including after a crash. The
/// path remains in place so contenders always lock the same inode.
#[derive(Debug)]
pub(crate) struct StateLock {
    _directory_file: File,
    _legacy_file: Option<File>,
}

impl StateLock {
    pub(crate) fn acquire(state_path: &Path) -> Result<Self, DaemonError> {
        if state_path.file_name() == Some(std::ffi::OsStr::new("daemon-runtime.lock")) {
            return Err(DaemonError::BadRequest(
                "The daemon state filename daemon-runtime.lock is reserved for runtime ownership. Choose a different state filename.".to_string(),
            ));
        }
        let lock_path = lock_path(state_path);
        let directory_file = acquire_file(state_path, &lock_path)?;
        // Existing builds lock the state filename. Retain that lock as well
        // so a new daemon cannot overlap one of those runtimes on the same
        // state path during the directory-lock transition.
        let mut legacy_path = state_path.as_os_str().to_os_string();
        legacy_path.push(".lock");
        let legacy_path = PathBuf::from(legacy_path);
        let legacy_file = (legacy_path != lock_path)
            .then(|| acquire_file(state_path, &legacy_path))
            .transpose()?;
        Ok(Self {
            _directory_file: directory_file,
            _legacy_file: legacy_file,
        })
    }
}

fn acquire_file(state_path: &Path, lock_path: &Path) -> Result<File, DaemonError> {
    if let Some(parent) = lock_path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(lock_path)?;
    match try_lock(&file) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
            return Err(DaemonError::Conflict(format!(
                "Daemon state {} is already in use by another FalconDeck runtime (lock {}). Connect to the running daemon or close its owning app first.",
                state_path.display(),
                lock_path.display(),
            )));
        }
        Err(error) => return Err(error.into()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    // Metadata is diagnostic only: flock, rather than a PID or a stale-file
    // check, remains the authority on whether a runtime owns this state.
    file.set_len(0)?;
    writeln!(file, "pid={}", std::process::id())?;
    Ok(file)
}

fn lock_path(state_path: &Path) -> PathBuf {
    // Preferences, agent control, extensions and other auxiliary stores use
    // fixed names beside state_path. A different state filename must not let
    // another daemon write those same stores concurrently.
    state_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("daemon-runtime.lock")
}

#[cfg(unix)]
fn try_lock(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;

    loop {
        // SAFETY: the file owns a valid descriptor for the duration of this
        // call; flock changes only the kernel's advisory lock for that file.
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(());
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::Interrupted {
            return Err(error);
        }
    }
}

#[cfg(not(unix))]
fn try_lock(file: &File) -> io::Result<()> {
    file.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => io::ErrorKind::WouldBlock.into(),
        std::fs::TryLockError::Error(error) => error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_state_path_rejects_a_second_owner() {
        let directory = tempfile::tempdir().unwrap();
        let state_path = directory.path().join("daemon-state.json");
        let _owner = StateLock::acquire(&state_path).unwrap();

        let error = StateLock::acquire(&state_path).unwrap_err();

        assert!(matches!(error, DaemonError::Conflict(_)));
        assert!(!state_path.exists());
    }

    #[test]
    fn dropping_owner_releases_the_lock_without_removing_the_file() {
        let directory = tempfile::tempdir().unwrap();
        let state_path = directory.path().join("daemon-state.json");
        let owner = StateLock::acquire(&state_path).unwrap();
        drop(owner);

        assert!(lock_path(&state_path).exists());
        let _next_owner = StateLock::acquire(&state_path).unwrap();
    }

    #[test]
    fn independent_state_paths_can_be_owned_concurrently() {
        let directory = tempfile::tempdir().unwrap();

        let _first = StateLock::acquire(&directory.path().join("first/state.json")).unwrap();
        let _second = StateLock::acquire(&directory.path().join("second/state.json")).unwrap();
    }

    #[test]
    fn different_state_filenames_cannot_share_auxiliary_stores() {
        let directory = tempfile::tempdir().unwrap();
        let _first = StateLock::acquire(&directory.path().join("first.json")).unwrap();

        assert!(matches!(
            StateLock::acquire(&directory.path().join("second.json")),
            Err(DaemonError::Conflict(_))
        ));
    }

    #[test]
    fn an_older_runtime_state_file_lock_prevents_a_new_owner() {
        let directory = tempfile::tempdir().unwrap();
        let state_path = directory.path().join("daemon-state.json");
        let legacy_path = directory.path().join("daemon-state.json.lock");
        let legacy_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(legacy_path)
            .unwrap();
        try_lock(&legacy_file).unwrap();

        assert!(matches!(
            StateLock::acquire(&state_path),
            Err(DaemonError::Conflict(_))
        ));
        drop(legacy_file);
        let _new_owner = StateLock::acquire(&state_path).unwrap();
    }

    #[test]
    fn reserved_lock_filename_is_rejected_without_overwriting_state() {
        let directory = tempfile::tempdir().unwrap();
        let state_path = directory.path().join(".").join("daemon-runtime.lock");
        let contents = "{\"workspaces\":[]}";
        std::fs::write(&state_path, contents).unwrap();

        assert!(matches!(
            StateLock::acquire(&state_path),
            Err(DaemonError::BadRequest(_))
        ));
        assert_eq!(std::fs::read_to_string(state_path).unwrap(), contents);
    }

    #[test]
    fn another_process_is_rejected_until_the_owner_exits() {
        let directory = tempfile::tempdir().unwrap();
        let state_path = directory.path().join("daemon-state.json");
        let owner = StateLock::acquire(&state_path).unwrap();
        run_subprocess_probe(&state_path, true);
        drop(owner);
        run_subprocess_probe(&state_path, false);
    }

    fn run_subprocess_probe(state_path: &Path, expect_conflict: bool) {
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "state_lock::tests::subprocess_probe",
                "--ignored",
                "--nocapture",
            ])
            .env("FALCONDECK_STATE_LOCK_TEST_PATH", state_path)
            .env(
                "FALCONDECK_STATE_LOCK_TEST_EXPECT_CONFLICT",
                expect_conflict.to_string(),
            )
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "state lock subprocess failed: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
    }

    #[test]
    #[ignore = "launched by the cross-process state lock test"]
    fn subprocess_probe() {
        let state_path =
            PathBuf::from(std::env::var_os("FALCONDECK_STATE_LOCK_TEST_PATH").unwrap());
        let expect_conflict =
            std::env::var("FALCONDECK_STATE_LOCK_TEST_EXPECT_CONFLICT").unwrap() == "true";
        let result = StateLock::acquire(&state_path);
        if expect_conflict {
            assert!(matches!(result, Err(DaemonError::Conflict(_))));
        } else {
            let _owner = result.unwrap();
        }
    }

    #[test]
    fn stale_pid_metadata_does_not_prevent_acquiring_an_unowned_lock() {
        let directory = tempfile::tempdir().unwrap();
        let state_path = directory.path().join("daemon-state.json");
        std::fs::write(lock_path(&state_path), "pid=1\n").unwrap();

        let _owner = StateLock::acquire(&state_path).unwrap();

        assert_eq!(
            std::fs::read_to_string(lock_path(&state_path)).unwrap(),
            format!("pid={}\n", std::process::id())
        );
    }

    #[test]
    fn lock_file_is_shared_by_the_state_directory() {
        assert_eq!(
            lock_path(Path::new("/tmp/config/daemon-state.json")),
            Path::new("/tmp/config/daemon-runtime.lock")
        );
    }

    #[cfg(unix)]
    #[test]
    fn lock_file_permissions_are_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let state_path = directory.path().join("daemon-state.json");
        let _owner = StateLock::acquire(&state_path).unwrap();

        assert_eq!(
            std::fs::metadata(lock_path(&state_path))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}

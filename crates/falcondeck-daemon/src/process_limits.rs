use std::io;

// macOS GUI launches inherit a soft limit of 256. Each warm agent holds pipes
// and sockets, so restoring many saved workspaces can exhaust that budget even
// without a leak. Reserve headroom before any agents or listeners are started.
const DESIRED_OPEN_FILES: libc::rlim_t = 8192;

fn desired_soft_limit(current: libc::rlim_t, hard: libc::rlim_t) -> libc::rlim_t {
    current.max(DESIRED_OPEN_FILES.min(hard))
}

pub(crate) fn prepare_file_descriptor_limit() -> io::Result<()> {
    let mut limits = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: limits is a valid writable rlimit for the duration of the call.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limits) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let previous = limits.rlim_cur;
    limits.rlim_cur = desired_soft_limit(previous, limits.rlim_max);
    if limits.rlim_cur == previous {
        return Ok(());
    }
    // SAFETY: limits is a valid rlimit; only the soft limit changes, within the
    // existing hard limit. No elevated privileges or system-wide changes.
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limits) } != 0 {
        return Err(io::Error::last_os_error());
    }
    tracing::info!(
        previous,
        current = limits.rlim_cur,
        hard = limits.rlim_max,
        "raised daemon file descriptor limit"
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::Command;

    #[test]
    fn respects_hard_limit_and_preserves_higher_soft_limits() {
        assert_eq!(desired_soft_limit(256, 1024), 1024);
        assert_eq!(desired_soft_limit(256, libc::RLIM_INFINITY), 8192);
        assert_eq!(desired_soft_limit(16384, 32768), 16384);
        assert_eq!(desired_soft_limit(256, 256), 256);
    }

    #[test]
    fn gui_launch_budget_can_open_more_than_256_files() {
        const CHILD_ENV: &str = "FALCONDECK_TEST_LOW_NOFILE";
        if std::env::var_os(CHILD_ENV).is_some() {
            prepare_file_descriptor_limit().unwrap();
            // Hold the handles concurrently, as warm agent pipes are held.
            let files: Vec<_> = (0..512)
                .map(|_| std::fs::File::open("/dev/null").unwrap())
                .collect();
            assert_eq!(files.len(), 512);
            return;
        }

        // Lower the limit only in a subprocess, never in the parallel test
        // harness. This recreates the Finder/launchd budget on macOS.
        let mut child = Command::new(std::env::current_exe().unwrap());
        child
            .args([
                "--exact",
                "process_limits::tests::gui_launch_budget_can_open_more_than_256_files",
                "--nocapture",
            ])
            .env(CHILD_ENV, "1");
        // SAFETY: the pre-exec callback only invokes async-signal-safe libc
        // calls, using stack storage, before the test subprocess execs.
        unsafe {
            child.pre_exec(|| {
                let mut limits = libc::rlimit {
                    rlim_cur: 0,
                    rlim_max: 0,
                };
                if libc::getrlimit(libc::RLIMIT_NOFILE, &mut limits) != 0 {
                    return Err(io::Error::last_os_error());
                }
                limits.rlim_cur = 256;
                if libc::setrlimit(libc::RLIMIT_NOFILE, &limits) != 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        assert!(child.status().unwrap().success());
    }
}

use std::{
    collections::HashMap,
    env,
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    time::Duration,
};

use tokio::{process::Command as TokioCommand, sync::OnceCell, time::timeout};

const LOGIN_SHELL_ENV_MARKER: &[u8] = b"__FALCONDECK_LOGIN_SHELL_ENV__\0";
const LOGIN_SHELL_ENV_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone)]
pub struct AgentBinaryResolution {
    pub executable: String,
    pub diagnostics: ResolutionDiagnostics,
}

#[derive(Debug, Clone, Default)]
pub struct ResolutionDiagnostics {
    pub configured: String,
    pub searched_path: bool,
    pub searched_login_shell: bool,
    pub checked_locations: Vec<String>,
}

/// Whether a binary resolves to an existing file, cached for a short window.
/// The uncached resolver can fall through to a blocking login-shell probe;
/// hot paths that only need existence (provider filtering, the settings
/// overview) must not pay that per call. Installations are rare, so a stale
/// answer self-corrects within the TTL.
pub(crate) fn agent_binary_available_cached(bin_name: &str, configured: &str) -> bool {
    use std::sync::Mutex;
    use std::time::{Duration, Instant};
    const TTL: Duration = Duration::from_secs(30);
    static CACHE: Mutex<Option<std::collections::HashMap<String, (Instant, bool)>>> =
        Mutex::new(None);

    let key = format!("{bin_name}\u{0}{configured}");
    if let Ok(guard) = CACHE.lock()
        && let Some(cache) = guard.as_ref()
        && let Some((probed_at, available)) = cache.get(&key)
        && probed_at.elapsed() < TTL
    {
        return *available;
    }
    let available = Path::new(&resolve_agent_binary(bin_name, configured).executable).is_file();
    if let Ok(mut guard) = CACHE.lock() {
        guard
            .get_or_insert_with(std::collections::HashMap::new)
            .insert(key, (Instant::now(), available));
    }
    available
}

pub fn resolve_agent_binary(bin_name: &str, configured: &str) -> AgentBinaryResolution {
    let configured = configured.trim();
    let mut diagnostics = ResolutionDiagnostics {
        configured: configured.to_string(),
        ..ResolutionDiagnostics::default()
    };

    if let Some(path) = normalize_existing_path(Path::new(configured)) {
        return AgentBinaryResolution {
            executable: path,
            diagnostics,
        };
    }

    let should_autodetect = configured.is_empty() || configured == bin_name;
    if !should_autodetect {
        return AgentBinaryResolution {
            executable: configured.to_string(),
            diagnostics,
        };
    }

    // Packaged macOS apps inherit a minimal launch-services PATH which can
    // select a stale /usr/local installation ahead of the user's active
    // Homebrew or standalone CLI. Prefer the standard user/macOS locations
    // in that environment; terminal-launched daemons still honor PATH first.
    let prefer_known_locations =
        cfg!(target_os = "macos") && env::var_os("__CFBundleIdentifier").is_some();
    if prefer_known_locations
        && let Some(path) = resolve_from_known_locations(bin_name, &mut diagnostics)
    {
        return AgentBinaryResolution {
            executable: path,
            diagnostics,
        };
    }

    if let Some(path) = resolve_from_path(bin_name) {
        diagnostics.searched_path = true;
        return AgentBinaryResolution {
            executable: path,
            diagnostics,
        };
    }
    diagnostics.searched_path = true;

    if !prefer_known_locations {
        if let Some(path) = resolve_from_known_locations(bin_name, &mut diagnostics) {
            return AgentBinaryResolution {
                executable: path,
                diagnostics,
            };
        }
    }

    if let Some(path) = resolve_from_login_shell(bin_name) {
        diagnostics.searched_login_shell = true;
        return AgentBinaryResolution {
            executable: path,
            diagnostics,
        };
    }
    diagnostics.searched_login_shell = true;

    AgentBinaryResolution {
        executable: configured.to_string(),
        diagnostics,
    }
}

pub fn missing_binary_message(
    provider_label: &str,
    bin_name: &str,
    diagnostics: &ResolutionDiagnostics,
    hint: &str,
) -> String {
    let configured = if diagnostics.configured.is_empty() {
        bin_name
    } else {
        diagnostics.configured.as_str()
    };
    let mut checks = Vec::new();
    checks.push(format!("configured value `{configured}`"));
    if diagnostics.searched_path {
        checks.push("the current PATH".to_string());
    }
    if !diagnostics.checked_locations.is_empty() {
        checks.push(format!(
            "common install locations ({})",
            diagnostics.checked_locations.join(", ")
        ));
    }
    if diagnostics.searched_login_shell {
        checks.push("your login shell via `command -v`".to_string());
    }

    format!(
        "{provider_label} could not be started because FalconDeck could not find the `{bin_name}` executable. Checked {}. {hint}",
        checks.join(", ")
    )
}

pub fn preferred_command_path(executable: &str) -> Option<OsString> {
    build_preferred_command_path(
        Path::new(executable),
        env::var_os("HOME"),
        env::var_os("PATH"),
    )
}

/// Removes env vars that advertise an attached Warp terminal from a
/// daemon-spawned harness process. Harness children have no controlling
/// terminal, but they inherit these vars when the daemon is launched from
/// Warp. Terminal-aware hook plugins (e.g. claude-code-warp) then believe
/// they can deliver notifications; with no tty they fall back to printing
/// hook JSON on stdout, which Codex rejects as invalid Stop hook output on
/// every turn. Stripping the vars makes those hooks take their headless
/// path and exit cleanly.
pub fn strip_terminal_advertising_env(command: &mut TokioCommand) {
    command.env_remove("WARP_CLI_AGENT_PROTOCOL_VERSION");
    command.env_remove("WARP_CLIENT_VERSION");
    if env::var_os("TERM_PROGRAM").as_deref() == Some(OsStr::new("WarpTerminal")) {
        command.env_remove("TERM_PROGRAM");
    }
}

/// Environment added by the user's interactive login shell when FalconDeck is
/// running as a packaged macOS app. Terminal-launched daemons already inherit
/// this environment and avoid the extra shell startup.
pub(crate) async fn desktop_login_shell_environment() -> &'static HashMap<OsString, OsString> {
    static ENVIRONMENT: OnceCell<HashMap<OsString, OsString>> = OnceCell::const_new();

    ENVIRONMENT
        .get_or_init(|| async {
            if !cfg!(target_os = "macos") || env::var_os("__CFBundleIdentifier").is_none() {
                return HashMap::new();
            }
            capture_login_shell_environment().await.unwrap_or_default()
        })
        .await
}

async fn capture_login_shell_environment() -> Option<HashMap<OsString, OsString>> {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut command = TokioCommand::new(shell);
    command
        .args([
            "-l",
            "-i",
            "-c",
            "printf '__FALCONDECK_LOGIN_SHELL_ENV__\\0'; /usr/bin/env -0",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = command_output_with_timeout(&mut command, LOGIN_SHELL_ENV_TIMEOUT).await?;
    if !output.status.success() {
        return None;
    }
    parse_login_shell_environment(&output.stdout)
}

async fn command_output_with_timeout(
    command: &mut TokioCommand,
    limit: Duration,
) -> Option<Output> {
    timeout(limit, command.output()).await.ok()?.ok()
}

fn parse_login_shell_environment(output: &[u8]) -> Option<HashMap<OsString, OsString>> {
    let marker = output
        .windows(LOGIN_SHELL_ENV_MARKER.len())
        .position(|window| window == LOGIN_SHELL_ENV_MARKER)?;
    let entries = &output[marker + LOGIN_SHELL_ENV_MARKER.len()..];
    Some(
        entries
            .split(|byte| *byte == 0)
            .filter_map(|entry| {
                let separator = entry.iter().position(|byte| *byte == b'=')?;
                let (key, value) = entry.split_at(separator);
                if key.is_empty() {
                    return None;
                }
                Some((
                    OsString::from(String::from_utf8_lossy(key).into_owned()),
                    OsString::from(String::from_utf8_lossy(&value[1..]).into_owned()),
                ))
            })
            .collect(),
    )
}

pub(crate) fn preferred_command_path_with_environment(
    executable: &str,
    environment: &HashMap<OsString, OsString>,
) -> Option<OsString> {
    build_preferred_command_path(
        Path::new(executable),
        environment
            .get(OsStr::new("HOME"))
            .cloned()
            .or_else(|| env::var_os("HOME")),
        environment
            .get(OsStr::new("PATH"))
            .cloned()
            .or_else(|| env::var_os("PATH")),
    )
}

fn resolve_from_path(bin_name: &str) -> Option<String> {
    env::var_os("PATH").and_then(|paths| {
        env::split_paths(&paths)
            .map(|dir| dir.join(bin_name))
            .find_map(|path| normalize_existing_path(&path))
    })
}

fn resolve_from_known_locations(
    bin_name: &str,
    diagnostics: &mut ResolutionDiagnostics,
) -> Option<String> {
    let mut candidates = Vec::new();

    if let Ok(home) = env::var("HOME") {
        candidates.push(PathBuf::from(&home).join(".local/bin").join(bin_name));
        candidates.push(PathBuf::from(&home).join(".cargo/bin").join(bin_name));
        // OpenCode's recommended install script keeps its standalone binary
        // here without necessarily adding the directory to GUI app PATHs.
        candidates.push(PathBuf::from(&home).join(".opencode/bin").join(bin_name));
    }

    #[cfg(target_os = "macos")]
    {
        candidates.push(PathBuf::from("/opt/homebrew/bin").join(bin_name));
        candidates.push(PathBuf::from("/usr/local/bin").join(bin_name));
    }

    #[cfg(target_os = "linux")]
    {
        candidates.push(PathBuf::from("/usr/local/bin").join(bin_name));
        candidates.push(PathBuf::from("/usr/bin").join(bin_name));
    }

    diagnostics.checked_locations = candidates
        .iter()
        .map(|path| path.display().to_string())
        .collect();

    candidates
        .into_iter()
        .find_map(|path| normalize_existing_path(&path))
}

fn resolve_from_login_shell(bin_name: &str) -> Option<String> {
    let shell = env::var("SHELL").unwrap_or_else(|_| {
        if cfg!(target_os = "macos") {
            "/bin/zsh".to_string()
        } else {
            "/bin/sh".to_string()
        }
    });

    let output = Command::new(shell)
        .args(["-l", "-c", &format!("command -v {bin_name}")])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let resolved = String::from_utf8_lossy(&output.stdout).trim().to_string();
    normalize_existing_path(Path::new(&resolved))
}

fn normalize_existing_path(path: &Path) -> Option<String> {
    if !path.is_absolute() || !path.is_file() {
        return None;
    }

    path.canonicalize()
        .ok()
        .map(|resolved| resolved.display().to_string())
}

fn build_preferred_command_path(
    executable: &Path,
    home: Option<OsString>,
    existing_path: Option<OsString>,
) -> Option<OsString> {
    let mut entries = Vec::new();

    if executable.is_absolute() {
        if let Some(parent) = executable.parent().map(Path::to_path_buf) {
            push_unique_path(&mut entries, parent);
        }
        if let Some(parent) = executable
            .canonicalize()
            .ok()
            .and_then(|path| path.parent().map(Path::to_path_buf))
        {
            push_unique_path(&mut entries, parent);
        }
    }

    if let Some(home) = home {
        let home = PathBuf::from(home);
        push_unique_path(&mut entries, home.join(".local/bin"));
        push_unique_path(&mut entries, home.join(".cargo/bin"));
        push_unique_path(&mut entries, home.join(".opencode/bin"));
    }

    #[cfg(target_os = "macos")]
    {
        push_unique_path(&mut entries, PathBuf::from("/opt/homebrew/bin"));
        push_unique_path(&mut entries, PathBuf::from("/usr/local/bin"));
    }

    #[cfg(target_os = "linux")]
    {
        push_unique_path(&mut entries, PathBuf::from("/usr/local/bin"));
        push_unique_path(&mut entries, PathBuf::from("/usr/bin"));
    }

    if let Some(existing_path) = existing_path {
        for entry in env::split_paths(&existing_path) {
            push_unique_path(&mut entries, entry);
        }
    }

    if entries.is_empty() {
        return None;
    }

    env::join_paths(entries).ok()
}

fn push_unique_path(entries: &mut Vec<PathBuf>, entry: PathBuf) {
    if entry.as_os_str().is_empty() || entries.iter().any(|existing| existing == &entry) {
        return;
    }
    entries.push(entry);
}

#[cfg(test)]
mod tests {
    use std::{
        ffi::OsString,
        path::{Path, PathBuf},
    };

    use super::{
        ResolutionDiagnostics, build_preferred_command_path, command_output_with_timeout,
        missing_binary_message, parse_login_shell_environment,
    };

    #[test]
    fn missing_binary_message_includes_checked_sources() {
        let diagnostics = ResolutionDiagnostics {
            configured: "claude".to_string(),
            searched_path: true,
            searched_login_shell: true,
            checked_locations: vec![
                "/Users/example/.local/bin/claude".to_string(),
                "/opt/homebrew/bin/claude".to_string(),
            ],
        };

        let message = missing_binary_message(
            "Claude Code",
            "claude",
            &diagnostics,
            "Install Claude Code or point FalconDeck at the binary path.",
        );

        assert!(message.contains("configured value `claude`"));
        assert!(message.contains("the current PATH"));
        assert!(message.contains("your login shell via `command -v`"));
        assert!(message.contains("/opt/homebrew/bin/claude"));
    }

    #[test]
    fn preferred_command_path_prioritizes_executable_parent() {
        let path = build_preferred_command_path(
            Path::new("/opt/homebrew/bin/codex"),
            Some(OsString::from("/Users/example")),
            Some(OsString::from("/usr/local/bin:/usr/bin")),
        )
        .expect("path should be built");

        let entries = std::env::split_paths(&path).collect::<Vec<PathBuf>>();

        assert_eq!(entries[0], PathBuf::from("/opt/homebrew/bin"));
        assert!(entries.contains(&PathBuf::from("/Users/example/.local/bin")));
        assert!(entries.contains(&PathBuf::from("/Users/example/.cargo/bin")));
        assert!(entries.contains(&PathBuf::from("/Users/example/.opencode/bin")));
        assert!(entries.contains(&PathBuf::from("/usr/local/bin")));
        assert!(entries.contains(&PathBuf::from("/usr/bin")));
    }

    #[test]
    fn login_shell_environment_ignores_startup_output_before_marker() {
        let output = b"shell banner\n__FALCONDECK_LOGIN_SHELL_ENV__\0OPENROUTER_API_KEY=test\0";

        let environment = parse_login_shell_environment(output).expect("environment should parse");

        assert_eq!(
            environment.get(std::ffi::OsStr::new("OPENROUTER_API_KEY")),
            Some(&OsString::from("test"))
        );
    }

    #[test]
    fn login_shell_environment_preserves_equals_in_values() {
        let output = b"__FALCONDECK_LOGIN_SHELL_ENV__\0TOKEN=first=second\0";

        let environment = parse_login_shell_environment(output).expect("environment should parse");

        assert_eq!(
            environment.get(std::ffi::OsStr::new("TOKEN")),
            Some(&OsString::from("first=second"))
        );
    }

    #[tokio::test]
    async fn login_shell_environment_command_is_bounded() {
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .args(["-c", "sleep 10"])
            .kill_on_drop(true)
            .stdout(std::process::Stdio::piped());

        let output =
            command_output_with_timeout(&mut command, std::time::Duration::from_millis(25)).await;

        assert!(output.is_none());
    }
}

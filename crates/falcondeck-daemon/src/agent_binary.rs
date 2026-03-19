use std::{
    env,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

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

    if let Some(path) = resolve_from_path(bin_name) {
        diagnostics.searched_path = true;
        return AgentBinaryResolution {
            executable: path,
            diagnostics,
        };
    }
    diagnostics.searched_path = true;

    if let Some(path) = resolve_from_known_locations(bin_name, &mut diagnostics) {
        return AgentBinaryResolution {
            executable: path,
            diagnostics,
        };
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

#[cfg(test)]
mod tests {
    use super::{ResolutionDiagnostics, missing_binary_message};

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
}

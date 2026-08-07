//! Minimal `~/.ssh/config` reader used by the "Add server" flow.
//!
//! The parser only needs to produce a pick-list of concrete host aliases for
//! the desktop UI. The alias itself is what gets handed to `ssh`, so `ssh`
//! still resolves the authoritative configuration when we connect — the
//! hostname/user/port returned here are display hints only.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use tokio::fs;

/// Maximum number of `Include` levels followed before giving up.
const MAX_INCLUDE_DEPTH: usize = 8;

/// A concrete (non-wildcard) `Host` entry from the SSH client config.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SshHostEntry {
    /// Host alias as written in the config; this is what we pass to `ssh`.
    pub name: String,
    /// Explicit `HostName`, when the block sets one.
    pub hostname: Option<String>,
    /// Explicit `User`, when the block sets one.
    pub user: Option<String>,
    /// Explicit `Port`, when the block sets one.
    pub port: Option<u16>,
}

/// Response body for `GET /api/ssh/hosts`.
#[derive(Debug, Clone, Serialize)]
pub struct SshHostsResponse {
    /// Host aliases discovered in the user's SSH config.
    pub hosts: Vec<SshHostEntry>,
}

/// Hosts and `Include` directives found in a single config file.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ParsedSshConfig {
    pub(crate) hosts: Vec<SshHostEntry>,
    pub(crate) includes: Vec<String>,
}

/// Reads `~/.ssh/config` and any files it includes.
///
/// A missing or unreadable config is not an error: the UI simply shows an
/// empty list and the user can type a target by hand.
pub async fn list_ssh_hosts() -> SshHostsResponse {
    let Some(home) = home_dir() else {
        return SshHostsResponse { hosts: Vec::new() };
    };
    let ssh_dir = home.join(".ssh");
    SshHostsResponse {
        hosts: collect_hosts(&ssh_dir.join("config"), &ssh_dir, &home).await,
    }
}

/// Walks `root` plus its transitive includes, keeping the first entry seen for
/// any given alias (matching `ssh`'s first-value-wins precedence).
async fn collect_hosts(root: &Path, ssh_dir: &Path, home: &Path) -> Vec<SshHostEntry> {
    let mut hosts = Vec::new();
    let mut seen_names = HashSet::new();
    let mut visited_files = HashSet::new();
    // (path, depth) pairs still to read.
    let mut queue = vec![(root.to_path_buf(), 0usize)];

    while !queue.is_empty() {
        let mut next_queue = Vec::new();
        for (path, depth) in std::mem::take(&mut queue) {
            if !visited_files.insert(path.clone()) {
                continue;
            }
            let Ok(text) = fs::read_to_string(&path).await else {
                continue;
            };
            let parsed = parse_ssh_config(&text);
            for host in parsed.hosts {
                if seen_names.insert(host.name.clone()) {
                    hosts.push(host);
                }
            }
            if depth >= MAX_INCLUDE_DEPTH {
                tracing::debug!("ssh config include depth exceeded at {}", path.display());
                continue;
            }
            for include in parsed.includes {
                for included in resolve_include(&include, ssh_dir, home).await {
                    next_queue.push((included, depth + 1));
                }
            }
        }
        queue = next_queue;
    }

    hosts
}

/// Expands one `Include` argument into concrete file paths, supporting the
/// `config.d/*` form that most generated configs use.
async fn resolve_include(pattern: &str, ssh_dir: &Path, home: &Path) -> Vec<PathBuf> {
    let expanded = if let Some(rest) = pattern.strip_prefix("~/") {
        home.join(rest)
    } else if pattern == "~" {
        home.to_path_buf()
    } else {
        let path = PathBuf::from(pattern);
        if path.is_absolute() {
            path
        } else {
            // Relative includes are resolved against ~/.ssh, like `ssh` does
            // for the per-user config.
            ssh_dir.join(path)
        }
    };

    let Some(file_name) = expanded.file_name().and_then(|name| name.to_str()) else {
        return Vec::new();
    };
    if !has_glob(file_name) {
        return vec![expanded];
    }

    // Only the final component is globbed; a glob in a parent directory is
    // rare enough that we skip it rather than walking the tree.
    let parent = expanded.parent().map(Path::to_path_buf).unwrap_or_default();
    if parent.to_str().is_some_and(has_glob) {
        return Vec::new();
    }
    let Ok(mut entries) = fs::read_dir(&parent).await else {
        return Vec::new();
    };
    let mut matches = Vec::new();
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        if name.starts_with('.') || !matches_glob(file_name, name) {
            continue;
        }
        matches.push(entry.path());
    }
    matches.sort();
    matches
}

/// Extracts concrete host blocks and `Include` directives from config text.
pub(crate) fn parse_ssh_config(text: &str) -> ParsedSshConfig {
    let mut parsed = ParsedSshConfig::default();
    // Host aliases sharing the block currently being read. Empty while inside
    // a wildcard-only `Host` block or a `Match` block, which we ignore.
    let mut current: Vec<SshHostEntry> = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((keyword, value)) = split_directive(line) else {
            continue;
        };
        let keyword = keyword.to_ascii_lowercase();

        match keyword.as_str() {
            "host" => {
                parsed.hosts.append(&mut current);
                current = value
                    .split_whitespace()
                    // Negated and wildcard patterns never name a single host.
                    .filter(|pattern| !has_glob(pattern) && !pattern.starts_with('!'))
                    .map(|pattern| SshHostEntry {
                        name: pattern.to_string(),
                        hostname: None,
                        user: None,
                        port: None,
                    })
                    .collect();
            }
            // A `Match` block ends the current `Host` block; its options are
            // conditional, so they must not be attributed to the last host.
            "match" => parsed.hosts.append(&mut current),
            "include" => parsed
                .includes
                .extend(value.split_whitespace().map(str::to_string)),
            "hostname" | "user" | "port" if !value.is_empty() => {
                // First value wins, as in `ssh`.
                for host in &mut current {
                    match keyword.as_str() {
                        "hostname" => {
                            host.hostname.get_or_insert_with(|| value.to_string());
                        }
                        "user" => {
                            host.user.get_or_insert_with(|| value.to_string());
                        }
                        _ => {
                            if host.port.is_none() {
                                host.port = value.parse::<u16>().ok();
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }

    parsed.hosts.append(&mut current);
    parsed
}

/// Splits `Keyword value` or `Keyword=value` into its two halves.
fn split_directive(line: &str) -> Option<(&str, &str)> {
    let split_at = line.find(|c: char| c.is_whitespace() || c == '=')?;
    let (keyword, rest) = line.split_at(split_at);
    let value = rest.trim_start().trim_start_matches('=').trim();
    Some((keyword, unquote(value)))
}

fn unquote(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or(value)
}

fn has_glob(value: &str) -> bool {
    value.contains('*') || value.contains('?')
}

/// Matches a file name against a `*`/`?` glob.
fn matches_glob(pattern: &str, name: &str) -> bool {
    let pattern: Vec<char> = pattern.chars().collect();
    let name: Vec<char> = name.chars().collect();
    let (mut p, mut n) = (0usize, 0usize);
    // Position to backtrack to when a `*` needs to consume one more character.
    let mut star: Option<(usize, usize)> = None;

    while n < name.len() {
        match pattern.get(p) {
            Some('*') => {
                star = Some((p, n));
                p += 1;
            }
            Some('?') => {
                p += 1;
                n += 1;
            }
            Some(c) if *c == name[n] => {
                p += 1;
                n += 1;
            }
            _ => match star {
                Some((star_p, star_n)) => {
                    p = star_p + 1;
                    n = star_n + 1;
                    star = Some((star_p, star_n + 1));
                }
                None => return false,
            },
        }
    }

    pattern[p..].iter().all(|c| *c == '*')
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = r#"
# Managed by something
Include ~/.orbstack/ssh/config
Include config.d/*

Host *
  ServerAliveInterval 60
  User fallback

Host quizgecko-ops-2
  HostName 167.235.248.77
  User forge
  Port 22

Host build-box gpu-box
  HostName 10.0.0.4
  User deploy

Host legacy
  Hostname=10.0.0.9
  PORT 2222

Host no-details

Host web-*
  HostName ignored.example.com

Host prod-?
  HostName ignored2.example.com

Host with-match
  HostName 10.0.0.7
Match host anything
  User should-not-attach
"#;

    fn host<'a>(parsed: &'a ParsedSshConfig, name: &str) -> &'a SshHostEntry {
        parsed
            .hosts
            .iter()
            .find(|host| host.name == name)
            .unwrap_or_else(|| panic!("missing host {name}"))
    }

    #[test]
    fn parses_host_blocks() {
        let parsed = parse_ssh_config(FIXTURE);
        let entry = host(&parsed, "quizgecko-ops-2");
        assert_eq!(entry.hostname.as_deref(), Some("167.235.248.77"));
        assert_eq!(entry.user.as_deref(), Some("forge"));
        assert_eq!(entry.port, Some(22));
    }

    #[test]
    fn skips_wildcard_patterns() {
        let parsed = parse_ssh_config(FIXTURE);
        let names: Vec<&str> = parsed.hosts.iter().map(|host| host.name.as_str()).collect();
        assert!(!names.contains(&"*"));
        assert!(!names.contains(&"web-*"));
        assert!(!names.contains(&"prod-?"));
    }

    #[test]
    fn expands_multi_pattern_host_lines() {
        let parsed = parse_ssh_config(FIXTURE);
        for name in ["build-box", "gpu-box"] {
            let entry = host(&parsed, name);
            assert_eq!(entry.hostname.as_deref(), Some("10.0.0.4"));
            assert_eq!(entry.user.as_deref(), Some("deploy"));
            assert_eq!(entry.port, None);
        }
    }

    #[test]
    fn accepts_equals_separators_and_mixed_case_keywords() {
        let parsed = parse_ssh_config(FIXTURE);
        let entry = host(&parsed, "legacy");
        assert_eq!(entry.hostname.as_deref(), Some("10.0.0.9"));
        assert_eq!(entry.port, Some(2222));
    }

    #[test]
    fn leaves_unset_fields_null() {
        let parsed = parse_ssh_config(FIXTURE);
        let entry = host(&parsed, "no-details");
        assert_eq!(entry.hostname, None);
        assert_eq!(entry.user, None);
        assert_eq!(entry.port, None);
    }

    #[test]
    fn stops_a_host_block_at_a_match_block() {
        let parsed = parse_ssh_config(FIXTURE);
        let entry = host(&parsed, "with-match");
        assert_eq!(entry.hostname.as_deref(), Some("10.0.0.7"));
        assert_eq!(entry.user, None);
    }

    #[test]
    fn collects_include_directives() {
        let parsed = parse_ssh_config(FIXTURE);
        assert_eq!(
            parsed.includes,
            vec![
                "~/.orbstack/ssh/config".to_string(),
                "config.d/*".to_string()
            ]
        );
    }

    #[test]
    fn ignores_comments_and_blank_lines() {
        let parsed = parse_ssh_config("# Host commented-out\n\n   # HostName nope\nHost real\n");
        assert_eq!(parsed.hosts.len(), 1);
        assert_eq!(parsed.hosts[0].name, "real");
    }

    #[test]
    fn keeps_the_first_value_for_repeated_keywords() {
        let parsed =
            parse_ssh_config("Host dupe\n  User first\n  User second\n  Port 22\n  Port 99\n");
        let entry = host(&parsed, "dupe");
        assert_eq!(entry.user.as_deref(), Some("first"));
        assert_eq!(entry.port, Some(22));
    }

    #[test]
    fn ignores_unparsable_ports() {
        let parsed = parse_ssh_config("Host bad-port\n  Port not-a-number\n");
        assert_eq!(host(&parsed, "bad-port").port, None);
    }

    #[test]
    fn glob_matching_handles_stars_and_single_characters() {
        assert!(matches_glob("*", "anything"));
        assert!(matches_glob("config.d/*", "config.d/x"));
        assert!(matches_glob("*.conf", "server.conf"));
        assert!(!matches_glob("*.conf", "server.conf.bak"));
        assert!(matches_glob("prod-?", "prod-1"));
        assert!(!matches_glob("prod-?", "prod-12"));
        assert!(matches_glob("a*b*c", "azzbzzc"));
        assert!(!matches_glob("a*b*c", "azzbzz"));
    }

    #[tokio::test]
    async fn resolves_globbed_includes_relative_to_the_ssh_directory() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path();
        let ssh_dir = home.join(".ssh");
        let config_d = ssh_dir.join("config.d");
        std::fs::create_dir_all(&config_d).expect("create config.d");
        std::fs::write(config_d.join("alpha"), "Host alpha\n  User a\n").expect("write alpha");
        std::fs::write(config_d.join("beta"), "Host beta\n  User b\n").expect("write beta");
        std::fs::write(ssh_dir.join("extra"), "Host extra\n").expect("write extra");

        let resolved = resolve_include("config.d/*", &ssh_dir, home).await;
        assert_eq!(
            resolved,
            vec![config_d.join("alpha"), config_d.join("beta")]
        );

        let direct = resolve_include("~/.ssh/extra", &ssh_dir, home).await;
        assert_eq!(direct, vec![ssh_dir.join("extra")]);
    }

    #[tokio::test]
    async fn walks_includes_and_deduplicates_aliases() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path();
        let ssh_dir = home.join(".ssh");
        let config_d = ssh_dir.join("config.d");
        std::fs::create_dir_all(&config_d).expect("create config.d");
        std::fs::write(
            ssh_dir.join("config"),
            "Include config.d/*\n\nHost primary\n  HostName 10.0.0.1\n",
        )
        .expect("write config");
        std::fs::write(
            config_d.join("extra"),
            "Host included\n  HostName 10.0.0.2\nHost primary\n  HostName 10.0.0.99\n",
        )
        .expect("write include");

        let hosts = collect_hosts(&ssh_dir.join("config"), &ssh_dir, home).await;
        let names: Vec<&str> = hosts.iter().map(|host| host.name.as_str()).collect();
        assert_eq!(names, vec!["primary", "included"]);
        // The root config is read first, so its value wins over the include.
        assert_eq!(hosts[0].hostname.as_deref(), Some("10.0.0.1"));
    }

    #[tokio::test]
    async fn missing_config_yields_no_hosts() {
        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path();
        let ssh_dir = home.join(".ssh");
        assert!(
            collect_hosts(&ssh_dir.join("config"), &ssh_dir, home)
                .await
                .is_empty()
        );
    }
}

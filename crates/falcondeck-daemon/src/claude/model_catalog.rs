use super::*;
use std::time::{Duration, Instant, SystemTime};

struct CachedCatalog {
    identity: (PathBuf, u64, Option<SystemTime>),
    fetched: Instant,
    models: Vec<DiscoveredClaudeModel>,
}

/// Initialize the native CLI without sending a user message or generating tokens.
/// Share the probe across workspaces, invalidating immediately when an upgrade
/// replaces the binary (including a native install's versioned symlink target).
async fn discover(claude_bin: &str) -> Vec<DiscoveredClaudeModel> {
    static CACHE: OnceLock<Mutex<Option<CachedCatalog>>> = OnceLock::new();
    let path = PathBuf::from(claude_bin);
    let Ok(metadata) = tokio::fs::metadata(&path).await else {
        return Vec::new();
    };
    let identity = (
        tokio::fs::canonicalize(&path).await.unwrap_or(path),
        metadata.len(),
        metadata.modified().ok(),
    );
    let mut cache = CACHE.get_or_init(|| Mutex::new(None)).lock().await;
    if let Some(cached) = cache.as_ref()
        && cached.identity == identity
        && cached.fetched.elapsed() < Duration::from_secs(60)
    {
        return cached.models.clone();
    }
    let models = probe(claude_bin).await.unwrap_or_default();
    *cache = Some(CachedCatalog {
        identity,
        fetched: Instant::now(),
        models: models.clone(),
    });
    models
}

async fn probe(claude_bin: &str) -> Option<Vec<DiscoveredClaudeModel>> {
    probe_with_timeout(claude_bin, Duration::from_secs(10)).await
}

async fn probe_with_timeout(
    claude_bin: &str,
    limit: Duration,
) -> Option<Vec<DiscoveredClaudeModel>> {
    let mut command = Command::new(claude_bin);
    command.args([
        "--safe-mode",
        "--setting-sources",
        "user",
        "--strict-mcp-config",
        "--mcp-config",
        "{\"mcpServers\":{}}",
        "--no-session-persistence",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "-p",
    ]);
    command
        .current_dir(env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    strip_terminal_advertising_env(&mut command);
    if let Some(path) = preferred_command_path(claude_bin) {
        command.env("PATH", path);
    }
    crate::agent_binary::validate_provider_command(&mut command).ok()?;
    // Keep the group guard outside the timeout so success, failure and
    // cancellation all clean up descendants, even after the leader exits.
    let mut child = command.spawn().ok()?;
    let _group = crate::agent_binary::ProbeProcessGroup(child.id());
    tokio::time::timeout(limit, async {
        let mut stdin = child.stdin.take()?;
        stdin.write_all(b"{\"type\":\"control_request\",\"request_id\":\"catalog\",\"request\":{\"subtype\":\"initialize\"}}\n").await.ok()?;
        drop(stdin);
        let models = read_catalog(child.stdout.take()?).await?;
        child.wait().await.ok()?.success().then_some(models)
    }).await.ok()?
}

const MAX_CATALOG_OUTPUT: u64 = 1024 * 1024;
const MAX_CATALOG_LINE: usize = 256 * 1024;

async fn read_catalog(
    stdout: impl tokio::io::AsyncRead + Unpin,
) -> Option<Vec<DiscoveredClaudeModel>> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
    let mut reader = BufReader::new(stdout.take(MAX_CATALOG_OUTPUT + 1));
    let mut total = 0;
    let mut line = Vec::new();
    let mut models = None;
    loop {
        let available = reader.fill_buf().await.ok()?;
        if available.is_empty() {
            if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                if let Some(found) = parse_initialize_models(&value) {
                    models = Some(found);
                }
            }
            return models;
        }
        let len = available
            .iter()
            .position(|b| *b == b'\n')
            .map_or(available.len(), |i| i + 1);
        total += len;
        if total > MAX_CATALOG_OUTPUT as usize || line.len() + len > MAX_CATALOG_LINE {
            return None;
        }
        line.extend_from_slice(&available[..len]);
        reader.consume(len);
        if line.last() == Some(&b'\n') {
            if let Ok(value) = serde_json::from_slice::<Value>(&line) {
                if let Some(found) = parse_initialize_models(&value) {
                    models = Some(found);
                }
            }
            line.clear();
        }
    }
}

fn parse_initialize_models(value: &Value) -> Option<Vec<DiscoveredClaudeModel>> {
    if value.get("type")?.as_str()? != "control_response"
        || value.pointer("/response/request_id")?.as_str()? != "catalog"
        || value.pointer("/response/subtype")?.as_str()? != "success"
    {
        return None;
    }
    let entries = value.pointer("/response/response/models")?.as_array()?;
    Some(
        entries
            .iter()
            .filter_map(|entry| {
                let id = entry.get("value")?.as_str()?;
                let label = entry.get("displayName")?.as_str()?.trim();
                // Keep FalconDeck's default selection; this row is a CLI preference.
                (id != "default" && is_claude_model_id(id) && !label.is_empty()).then(|| {
                    DiscoveredClaudeModel {
                        id: id.into(),
                        label: label.into(),
                    }
                })
            })
            .collect(),
    )
}

pub(super) async fn list_models_for_bin(claude_bin: &str) -> Vec<ModelSummary> {
    let mut models = fallback_models().await;
    let discovered = discover(claude_bin).await;
    for model in &mut models {
        let family = model.id.strip_suffix("[1m]").unwrap_or(&model.id);
        if let Some(current) = discovered
            .iter()
            .find(|row| row.id.eq_ignore_ascii_case(family))
        {
            model.label = if model.id.ends_with("[1m]") {
                format!("{} 1M", current.label)
            } else {
                current.label.clone()
            };
        }
    }
    merge_claude_models(models, &discovered)
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn catalog_output_and_lines_are_bounded_before_parsing() {
        let valid = br#"{"type":"control_response","response":{"subtype":"success","request_id":"catalog","response":{"models":[]}}}"#;
        assert_eq!(read_catalog(&valid[..]).await, Some(Vec::new()));
        assert!(
            read_catalog(&vec![b'x'; MAX_CATALOG_LINE + 1][..])
                .await
                .is_none()
        );
        let mut output = Vec::new();
        for _ in 0..(MAX_CATALOG_OUTPUT as usize / 2 + 1) {
            output.extend_from_slice(b"x\n");
        }
        assert!(read_catalog(&output[..]).await.is_none());
        output.extend_from_slice(valid);
        assert!(read_catalog(&output[..]).await.is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn hanging_catalog_kills_descendants_and_returns_fallback() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("claude");
        let marker = temp.path().join("leaked-child");
        fs::write(
            &bin,
            format!(
                "#!/bin/sh\nread request\n(/bin/sleep 0.4; /usr/bin/touch '{}') &\nexit 0\n",
                marker.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(
            probe_with_timeout(bin.to_str().unwrap(), Duration::from_millis(50))
                .await
                .is_none()
        );
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(!marker.exists(), "catalog descendant survived timeout");
        let models = list_models_for_bin("/missing-test-claude").await;
        assert!(models.iter().any(|m| m.id == "sonnet" && m.is_default));
    }

    use super::*;

    #[test]
    fn reads_native_catalog_and_rejects_unrelated_responses() {
        let mut response = json!({"type":"control_response", "response": {
            "subtype":"success", "request_id":"catalog", "response": {"models":[
                {"value":"default", "displayName":"Default (recommended)"},
                {"value":"fable", "displayName":"Fable 5.2"},
                {"value":"bad model", "displayName":"Invalid"},
                {"value":"opus"}
            ]}
        }});
        assert_eq!(
            parse_initialize_models(&response).unwrap(),
            vec![DiscoveredClaudeModel {
                id: "fable".into(),
                label: "Fable 5.2".into()
            }]
        );
        response["response"]["request_id"] = json!("other");
        assert!(parse_initialize_models(&response).is_none());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn native_probe_updates_aliases_and_full_context_labels() {
        use std::os::unix::fs::PermissionsExt;
        let temp = tempfile::tempdir().unwrap();
        let bin = temp.path().join("claude");
        fs::write(&bin, r##"#!/bin/sh
read request
printf '%s\n' '{"type":"control_response","response":{"subtype":"success","request_id":"catalog","response":{"models":[{"value":"fable","displayName":"Fable 5.2"}]}}}'
"##).unwrap();
        fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        let models = list_models_for_bin(bin.to_str().unwrap()).await;
        assert_eq!(
            models.iter().find(|m| m.id == "fable").unwrap().label,
            "Fable 5.2"
        );
        assert_eq!(
            models.iter().find(|m| m.id == "fable[1m]").unwrap().label,
            "Fable 5.2 1M"
        );
        assert!(models.iter().find(|m| m.id == "sonnet").unwrap().is_default);
        // A failed probe must retain the usable fallback catalog.
        fs::write(&bin, "#!/bin/sh\nexit 1\n").unwrap();
        let fallback = list_models_for_bin(bin.to_str().unwrap()).await;
        assert_eq!(
            fallback.iter().find(|m| m.id == "fable").unwrap().label,
            "Fable 5.1"
        );
    }
}

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
    strip_terminal_advertising_env(&mut command);
    if let Some(path) = preferred_command_path(claude_bin) {
        command.env("PATH", path);
    }
    crate::agent_binary::validate_provider_command(&mut command).ok()?;
    let output = tokio::time::timeout(Duration::from_secs(10), async {
        let mut child = command.spawn().ok()?;
        let mut stdin = child.stdin.take()?;
        stdin.write_all(b"{\"type\":\"control_request\",\"request_id\":\"catalog\",\"request\":{\"subtype\":\"initialize\"}}\n").await.ok()?;
        drop(stdin);
        child.wait_with_output().await.ok()
    }).await.ok()??;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(|line| {
            let value: Value = serde_json::from_str(line).ok()?;
            parse_initialize_models(&value)
        })
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
    let mut models = list_models().await;
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

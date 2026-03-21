use std::{
    env,
    path::{Path, PathBuf},
};

#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::OnceLock;

use falcondeck_core::{
    crypto::verify_pairing_public_key_bundle, AgentProvider,
    ConversationAutoExpandPreferencesPatch, FalconDeckPreferences, ToolDetailsMode,
    UpdatePreferencesRequest,
};
use serde::Deserialize;
use serde_json::Value;
use tokio::fs;

use super::{
    encode_base64, PersistedAppState, PersistedRemoteSecrets, PersistedRemoteState,
    PersistedWorkspaceEntry, PersistedWorkspaceState, RemoteBridgeState,
};
use crate::codex::extract_string;
use crate::error::DaemonError;

pub(super) fn default_state_path() -> PathBuf {
    let home = env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    home.join(".falcondeck").join("daemon-state.json")
}

pub(super) fn default_preferences_path(state_path: &Path) -> PathBuf {
    state_path
        .parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("falcondeck.json")
}

pub(super) fn default_persisted_provider() -> Option<AgentProvider> {
    Some(AgentProvider::Codex)
}

pub(super) async fn load_persisted_app_state(
    path: &PathBuf,
) -> Result<PersistedAppState, DaemonError> {
    match fs::read_to_string(path).await {
        Ok(contents) => serde_json::from_str(&contents).map_err(DaemonError::from),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(PersistedAppState::default())
        }
        Err(error) => Err(DaemonError::Io(error)),
    }
}

pub(super) async fn load_preferences(path: &PathBuf) -> Result<FalconDeckPreferences, DaemonError> {
    match fs::read_to_string(path).await {
        Ok(contents) => {
            let value: Value = serde_json::from_str(&contents)?;
            Ok(merge_preferences_from_value(value))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(FalconDeckPreferences::default())
        }
        Err(error) => Err(DaemonError::Io(error)),
    }
}

pub(super) fn normalize_workspace_path(path: &str) -> String {
    PathBuf::from(path)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .to_string()
}

pub(super) fn deserialize_persisted_workspaces<'de, D>(
    deserializer: D,
) -> Result<Vec<PersistedWorkspaceState>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let entries = Vec::<PersistedWorkspaceEntry>::deserialize(deserializer)?;
    Ok(entries
        .into_iter()
        .map(|entry| match entry {
            PersistedWorkspaceEntry::LegacyPath(path) => PersistedWorkspaceState {
                path,
                current_thread_id: None,
                updated_at: None,
                default_provider: Some(AgentProvider::Codex),
                last_error: None,
                archived_thread_ids: Vec::new(),
                thread_states: Vec::new(),
            },
            PersistedWorkspaceEntry::State(workspace) => workspace,
        })
        .collect())
}

pub(super) async fn persist_app_state(
    path: &PathBuf,
    state: &PersistedAppState,
) -> Result<(), DaemonError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let tmp_path = path.with_extension("json.tmp");
    let payload = serde_json::to_vec_pretty(state)?;
    fs::write(&tmp_path, payload).await?;
    fs::rename(&tmp_path, path).await?;
    Ok(())
}

pub(super) async fn persist_preferences(
    path: &PathBuf,
    preferences: &FalconDeckPreferences,
) -> Result<(), DaemonError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let tmp_path = path.with_extension("json.tmp");
    let payload = serde_json::to_vec_pretty(preferences)?;
    fs::write(&tmp_path, payload).await?;
    fs::rename(&tmp_path, path).await?;
    Ok(())
}

pub(super) fn merge_preferences_from_value(value: Value) -> FalconDeckPreferences {
    let mut preferences = FalconDeckPreferences::default();
    if let Some(version) = value.get("version").and_then(Value::as_u64) {
        preferences.version = version as u32;
    }

    if let Some(conversation) = value.get("conversation") {
        if let Some(mode) = extract_string(conversation, &["tool_details_mode"]) {
            preferences.conversation.tool_details_mode = parse_tool_details_mode(&mode);
        }
        if let Some(group) = conversation
            .get("group_read_only_tools")
            .and_then(Value::as_bool)
        {
            preferences.conversation.group_read_only_tools = group;
        }
        if let Some(show) = conversation
            .get("show_expand_all_controls")
            .and_then(Value::as_bool)
        {
            preferences.conversation.show_expand_all_controls = show;
        }
        if let Some(auto_expand) = conversation.get("auto_expand") {
            if let Some(value) = auto_expand.get("approvals").and_then(Value::as_bool) {
                preferences.conversation.auto_expand.approvals = value;
            }
            if let Some(value) = auto_expand.get("errors").and_then(Value::as_bool) {
                preferences.conversation.auto_expand.errors = value;
            }
            if let Some(value) = auto_expand.get("first_diff").and_then(Value::as_bool) {
                preferences.conversation.auto_expand.first_diff = value;
            }
            if let Some(value) = auto_expand.get("failed_tests").and_then(Value::as_bool) {
                preferences.conversation.auto_expand.failed_tests = value;
            }
        }
    }

    preferences
}

pub(super) fn apply_preferences_patch(
    preferences: &mut FalconDeckPreferences,
    request: UpdatePreferencesRequest,
) {
    let Some(conversation) = request.conversation else {
        return;
    };

    if let Some(mode) = conversation.tool_details_mode {
        preferences.conversation.tool_details_mode = mode;
    }
    if let Some(value) = conversation.group_read_only_tools {
        preferences.conversation.group_read_only_tools = value;
    }
    if let Some(value) = conversation.show_expand_all_controls {
        preferences.conversation.show_expand_all_controls = value;
    }
    if let Some(auto_expand) = conversation.auto_expand {
        apply_auto_expand_patch(&mut preferences.conversation.auto_expand, auto_expand);
    }
}

pub(super) fn apply_auto_expand_patch(
    current: &mut falcondeck_core::ConversationAutoExpandPreferences,
    patch: ConversationAutoExpandPreferencesPatch,
) {
    if let Some(value) = patch.approvals {
        current.approvals = value;
    }
    if let Some(value) = patch.errors {
        current.errors = value;
    }
    if let Some(value) = patch.first_diff {
        current.first_diff = value;
    }
    if let Some(value) = patch.failed_tests {
        current.failed_tests = value;
    }
}

pub(super) fn parse_tool_details_mode(value: &str) -> ToolDetailsMode {
    match value {
        "expanded" => ToolDetailsMode::Expanded,
        "compact" => ToolDetailsMode::Compact,
        "hide_read_only_details" => ToolDetailsMode::HideReadOnlyDetails,
        _ => ToolDetailsMode::Auto,
    }
}

pub(super) fn persisted_remote_state(
    remote: &RemoteBridgeState,
) -> Result<Option<PersistedRemoteState>, DaemonError> {
    let Some(relay_url) = remote.relay_url.clone() else {
        return Ok(None);
    };
    let Some(daemon_token) = remote.daemon_token.clone() else {
        return Ok(None);
    };
    let Some(pairing) = remote.pairing.as_ref() else {
        return Ok(None);
    };
    let secure_storage_key = remote_secret_storage_key(
        &relay_url,
        &pairing.pairing_id,
        pairing.session_id.as_deref(),
    );
    save_remote_secrets(
        &secure_storage_key,
        &PersistedRemoteSecrets {
            local_secret_key_base64: pairing.local_key_pair.secret_key_base64(),
            data_key_base64: encode_base64(&pairing.data_key),
        },
    )?;
    Ok(Some(PersistedRemoteState {
        relay_url,
        daemon_token,
        pairing_id: pairing.pairing_id.clone(),
        pairing_code: pairing.pairing_code.clone(),
        session_id: pairing.session_id.clone(),
        device_id: pairing.device_id.clone(),
        trusted_at: pairing.trusted_at,
        expires_at: pairing.expires_at,
        client_bundle: pairing.client_bundle.clone(),
        client_public_key: None,
        secure_storage_key: Some(secure_storage_key),
        local_secret_key_base64: None,
        data_key_base64: None,
    }))
}

pub(super) fn invalid_persisted_remote_reason(remote: &PersistedRemoteState) -> Option<String> {
    remote.device_id.as_ref()?;

    let Some(client_bundle) = remote.client_bundle.as_ref() else {
        return if remote.client_public_key.is_some() {
            Some("trusted remote only has legacy unsigned client key material".to_string())
        } else {
            Some("trusted remote is missing signed client key material".to_string())
        };
    };

    verify_pairing_public_key_bundle(client_bundle)
        .err()
        .map(|error| format!("trusted remote has invalid signed client key material: {error}"))
}

pub(super) fn remote_secret_storage_key(
    relay_url: &str,
    pairing_id: &str,
    session_id: Option<&str>,
) -> String {
    let identity = session_id.unwrap_or(pairing_id);
    format!("{relay_url}|{identity}")
}

pub(super) fn load_remote_secrets(
    remote: &PersistedRemoteState,
    secure_storage_key: &str,
) -> Result<PersistedRemoteSecrets, DaemonError> {
    if let (Some(local_secret_key_base64), Some(data_key_base64)) = (
        remote.local_secret_key_base64.clone(),
        remote.data_key_base64.clone(),
    ) {
        return Ok(PersistedRemoteSecrets {
            local_secret_key_base64,
            data_key_base64,
        });
    }

    load_remote_secrets_from_secure_storage(secure_storage_key)
}

pub(super) fn save_remote_secrets(
    secure_storage_key: &str,
    secrets: &PersistedRemoteSecrets,
) -> Result<(), DaemonError> {
    save_remote_secrets_to_secure_storage(secure_storage_key, secrets)
}

pub(super) fn delete_remote_secrets(secure_storage_key: String) -> Result<(), DaemonError> {
    delete_remote_secrets_from_secure_storage(&secure_storage_key)
}

#[cfg(not(test))]
pub(super) fn save_remote_secrets_to_secure_storage(
    secure_storage_key: &str,
    secrets: &PersistedRemoteSecrets,
) -> Result<(), DaemonError> {
    let payload = serde_json::to_string(secrets)?;
    let entry = keyring::Entry::new("com.falcondeck.daemon.remote", secure_storage_key)
        .map_err(|error| DaemonError::Process(format!("failed to open secure storage: {error}")))?;
    entry
        .set_password(&payload)
        .map_err(|error| DaemonError::Process(format!("failed to write secure storage: {error}")))
}

#[cfg(not(test))]
pub(super) fn load_remote_secrets_from_secure_storage(
    secure_storage_key: &str,
) -> Result<PersistedRemoteSecrets, DaemonError> {
    let entry = keyring::Entry::new("com.falcondeck.daemon.remote", secure_storage_key)
        .map_err(|error| DaemonError::Process(format!("failed to open secure storage: {error}")))?;
    let payload = entry
        .get_password()
        .map_err(|error| DaemonError::Process(format!("failed to read secure storage: {error}")))?;
    serde_json::from_str::<PersistedRemoteSecrets>(&payload).map_err(|error| {
        DaemonError::BadRequest(format!("invalid secure storage payload: {error}"))
    })
}

#[cfg(not(test))]
pub(super) fn delete_remote_secrets_from_secure_storage(
    secure_storage_key: &str,
) -> Result<(), DaemonError> {
    let entry = keyring::Entry::new("com.falcondeck.daemon.remote", secure_storage_key)
        .map_err(|error| DaemonError::Process(format!("failed to open secure storage: {error}")))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(DaemonError::Process(format!(
            "failed to delete secure storage entry: {error}"
        ))),
    }
}

#[cfg(test)]
static TEST_REMOTE_SECRET_STORE: OnceLock<std::sync::Mutex<HashMap<String, String>>> =
    OnceLock::new();

#[cfg(test)]
fn test_remote_secret_store() -> &'static std::sync::Mutex<HashMap<String, String>> {
    TEST_REMOTE_SECRET_STORE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

#[cfg(test)]
pub(super) fn save_remote_secrets_to_secure_storage(
    secure_storage_key: &str,
    secrets: &PersistedRemoteSecrets,
) -> Result<(), DaemonError> {
    let payload = serde_json::to_string(secrets)?;
    test_remote_secret_store()
        .lock()
        .unwrap()
        .insert(secure_storage_key.to_string(), payload);
    Ok(())
}

#[cfg(test)]
pub(super) fn load_remote_secrets_from_secure_storage(
    secure_storage_key: &str,
) -> Result<PersistedRemoteSecrets, DaemonError> {
    let payload = test_remote_secret_store()
        .lock()
        .unwrap()
        .get(secure_storage_key)
        .cloned()
        .ok_or_else(|| {
            DaemonError::BadRequest("missing persisted relay secrets in secure storage".to_string())
        })?;
    serde_json::from_str::<PersistedRemoteSecrets>(&payload).map_err(|error| {
        DaemonError::BadRequest(format!("invalid secure storage payload: {error}"))
    })
}

#[cfg(test)]
pub(super) fn delete_remote_secrets_from_secure_storage(
    secure_storage_key: &str,
) -> Result<(), DaemonError> {
    test_remote_secret_store()
        .lock()
        .unwrap()
        .remove(secure_storage_key);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, Utc};
    use falcondeck_core::crypto::{build_pairing_public_key_bundle, LocalBoxKeyPair};
    use serde::de::value::{SeqDeserializer, StringDeserializer};
    use serde_json::json;

    use crate::app::PersistedWorkspaceState;

    #[test]
    fn derives_preferences_path_next_to_state_file() {
        let path = default_preferences_path(Path::new("/tmp/falcondeck/daemon-state.json"));
        assert_eq!(path, PathBuf::from("/tmp/falcondeck/falcondeck.json"));
    }

    #[test]
    fn deserializes_legacy_workspace_paths_with_codex_default() {
        let entries = vec!["/tmp/project-a".to_string(), "/tmp/project-b".to_string()];
        let deserializer = SeqDeserializer::<_, serde_json::Error>::new(
            entries
                .into_iter()
                .map(StringDeserializer::<serde_json::Error>::new),
        );

        let workspaces = deserialize_persisted_workspaces(deserializer).unwrap();

        assert_eq!(
            workspaces,
            vec![
                PersistedWorkspaceState {
                    path: "/tmp/project-a".to_string(),
                    current_thread_id: None,
                    updated_at: None,
                    default_provider: Some(AgentProvider::Codex),
                    last_error: None,
                    archived_thread_ids: Vec::new(),
                    thread_states: Vec::new(),
                },
                PersistedWorkspaceState {
                    path: "/tmp/project-b".to_string(),
                    current_thread_id: None,
                    updated_at: None,
                    default_provider: Some(AgentProvider::Codex),
                    last_error: None,
                    archived_thread_ids: Vec::new(),
                    thread_states: Vec::new(),
                },
            ]
        );
    }

    #[test]
    fn merges_preferences_from_partial_json_payload() {
        let preferences = merge_preferences_from_value(json!({
            "version": 3,
            "conversation": {
                "tool_details_mode": "compact",
                "group_read_only_tools": false,
                "show_expand_all_controls": true,
                "auto_expand": {
                    "approvals": false,
                    "errors": true,
                    "first_diff": false,
                    "failed_tests": true
                }
            }
        }));

        assert_eq!(preferences.version, 3);
        assert_eq!(
            preferences.conversation.tool_details_mode,
            ToolDetailsMode::Compact
        );
        assert!(!preferences.conversation.group_read_only_tools);
        assert!(preferences.conversation.show_expand_all_controls);
        assert!(!preferences.conversation.auto_expand.approvals);
        assert!(preferences.conversation.auto_expand.errors);
        assert!(!preferences.conversation.auto_expand.first_diff);
        assert!(preferences.conversation.auto_expand.failed_tests);
    }

    #[test]
    fn inline_remote_secrets_take_priority_over_secure_storage() {
        let secure_storage_key = "test-inline-secrets";
        save_remote_secrets_to_secure_storage(
            secure_storage_key,
            &PersistedRemoteSecrets {
                local_secret_key_base64: "stored-secret".to_string(),
                data_key_base64: "stored-key".to_string(),
            },
        )
        .unwrap();

        let secrets = load_remote_secrets(
            &PersistedRemoteState {
                relay_url: "https://connect.falcondeck.com".to_string(),
                daemon_token: "daemon-token".to_string(),
                pairing_id: "pairing-1".to_string(),
                pairing_code: "ABCDEFGHJKLM".to_string(),
                session_id: Some("session-inline".to_string()),
                device_id: Some("device-1".to_string()),
                trusted_at: Some(Utc::now()),
                expires_at: Utc::now() + Duration::minutes(10),
                client_bundle: None,
                client_public_key: None,
                secure_storage_key: Some(secure_storage_key.to_string()),
                local_secret_key_base64: Some("inline-secret".to_string()),
                data_key_base64: Some("inline-key".to_string()),
            },
            secure_storage_key,
        )
        .unwrap();

        assert_eq!(secrets.local_secret_key_base64, "inline-secret");
        assert_eq!(secrets.data_key_base64, "inline-key");
    }

    #[test]
    fn ignores_untrusted_remote_when_validating_signed_client_material() {
        let remote = PersistedRemoteState {
            relay_url: "https://connect.falcondeck.com".to_string(),
            daemon_token: "daemon-token".to_string(),
            pairing_id: "pairing-1".to_string(),
            pairing_code: "ABCDEFGHJKLM".to_string(),
            session_id: Some("session-1".to_string()),
            device_id: None,
            trusted_at: None,
            expires_at: Utc::now() + Duration::minutes(10),
            client_bundle: None,
            client_public_key: None,
            secure_storage_key: None,
            local_secret_key_base64: None,
            data_key_base64: None,
        };

        assert!(invalid_persisted_remote_reason(&remote).is_none());
    }

    #[test]
    fn reports_invalid_signed_client_material_for_trusted_remote() {
        let mut bundle = build_pairing_public_key_bundle(&LocalBoxKeyPair::generate());
        bundle.signature = "invalid-signature".to_string();
        let remote = PersistedRemoteState {
            relay_url: "https://connect.falcondeck.com".to_string(),
            daemon_token: "daemon-token".to_string(),
            pairing_id: "pairing-1".to_string(),
            pairing_code: "ABCDEFGHJKLM".to_string(),
            session_id: Some("session-1".to_string()),
            device_id: Some("device-1".to_string()),
            trusted_at: Some(Utc::now()),
            expires_at: Utc::now() + Duration::minutes(10),
            client_bundle: Some(bundle),
            client_public_key: None,
            secure_storage_key: None,
            local_secret_key_base64: None,
            data_key_base64: None,
        };

        let reason = invalid_persisted_remote_reason(&remote).unwrap();
        assert!(reason.contains("invalid signed client key material"));
    }
}

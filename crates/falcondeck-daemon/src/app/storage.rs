#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    env,
    io::Write,
    path::{Path, PathBuf},
};

#[cfg(test)]
use std::collections::HashMap;
#[cfg(test)]
use std::sync::OnceLock;

use falcondeck_core::{
    AgentProvider, ConversationAutoExpandPreferencesPatch, FalconDeckPreferences, ToolDetailsMode,
    UpdatePreferencesRequest, crypto::verify_pairing_public_key_bundle,
};
use serde::Deserialize;
use serde_json::Value;
use tokio::{
    fs,
    io::AsyncWriteExt,
    task::spawn_blocking,
    time::{Duration, timeout},
};

use super::{
    PersistedAppState, PersistedRemoteSecrets, PersistedRemoteState, PersistedWorkspaceEntry,
    PersistedWorkspaceState, RemoteBridgeState, encode_base64,
};
use crate::codex::extract_string;
use crate::error::DaemonError;

pub(super) const SECURE_STORAGE_TIMEOUT: Duration = Duration::from_secs(10);

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
    Some(AgentProvider::CODEX)
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
                default_provider: Some(AgentProvider::CODEX),
                last_error: None,
                archived_thread_ids: Vec::new(),
                pinned_thread_ids: Vec::new(),
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
    let payload = serde_json::to_vec_pretty(state)?;
    write_atomically(path, payload).await
}

pub(super) async fn persist_preferences(
    path: &PathBuf,
    preferences: &FalconDeckPreferences,
) -> Result<(), DaemonError> {
    let payload = serde_json::to_vec_pretty(preferences)?;
    write_atomically(path, payload).await
}

/// Persist callers run concurrently; a shared temp path would let one
/// writer's rename publish another writer's half-written file. Each write
/// gets its own temp file so the atomic rename is the only shared step.
async fn write_atomically(path: &PathBuf, payload: Vec<u8>) -> Result<(), DaemonError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let tmp_path = path.with_extension(format!("json.tmp.{}", uuid::Uuid::new_v4().simple()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(&tmp_path).await?;
    if let Err(error) = async {
        file.write_all(&payload).await?;
        file.sync_all().await
    }
    .await
    {
        drop(file);
        let _ = fs::remove_file(&tmp_path).await;
        return Err(error.into());
    }
    drop(file);
    if let Err(error) = fs::rename(&tmp_path, path).await {
        let _ = fs::remove_file(&tmp_path).await;
        return Err(error.into());
    }
    #[cfg(unix)]
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).await?;
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
        "collapsed" => ToolDetailsMode::Collapsed,
        "expanded" => ToolDetailsMode::Expanded,
        "compact" => ToolDetailsMode::Compact,
        "hide_read_only_details" => ToolDetailsMode::HideReadOnlyDetails,
        "auto" => ToolDetailsMode::Auto,
        _ => ToolDetailsMode::Collapsed,
    }
}

pub(super) fn persisted_remote_state(
    remote: &RemoteBridgeState,
) -> Result<Option<(PersistedRemoteState, PersistedRemoteSecrets)>, DaemonError> {
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
    let secrets = PersistedRemoteSecrets {
        local_secret_key_base64: pairing.local_key_pair.secret_key_base64(),
        data_key_base64: encode_base64(&pairing.data_key),
    };
    Ok(Some((
        PersistedRemoteState {
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
            trusted_client_bundles: remote.trusted_client_bundles.clone(),
        },
        secrets,
    )))
}

pub(super) fn invalid_persisted_remote_reason(remote: &PersistedRemoteState) -> Option<String> {
    remote.device_id.as_ref()?;

    let Some(client_bundle) = remote.client_bundle.as_ref() else {
        return if remote.client_public_key.is_some() {
            Some("trusted remote only has legacy unsigned client key material".to_string())
        } else {
            None
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

pub(super) async fn load_remote_secrets_async(
    remote: PersistedRemoteState,
    secure_storage_key: String,
) -> Result<PersistedRemoteSecrets, DaemonError> {
    if remote.local_secret_key_base64.is_some() && remote.data_key_base64.is_some() {
        return load_remote_secrets(&remote, &secure_storage_key);
    }

    timeout(
        SECURE_STORAGE_TIMEOUT,
        spawn_blocking(move || load_remote_secrets(&remote, &secure_storage_key)),
    )
    .await
    .map_err(|_| DaemonError::Process("timed out reading persisted remote secrets".to_string()))?
    .map_err(|error| DaemonError::Process(format!("secure storage task failed: {error}")))?
}

pub(super) async fn save_remote_secrets_async(
    secure_storage_key: String,
    secrets: PersistedRemoteSecrets,
) -> Result<(), DaemonError> {
    timeout(
        SECURE_STORAGE_TIMEOUT,
        spawn_blocking(move || save_remote_secrets(&secure_storage_key, &secrets)),
    )
    .await
    .map_err(|_| DaemonError::Process("timed out writing persisted remote secrets".to_string()))?
    .map_err(|error| DaemonError::Process(format!("secure storage task failed: {error}")))?
}

pub(super) async fn delete_remote_secrets_async(
    secure_storage_key: String,
) -> Result<(), DaemonError> {
    timeout(
        SECURE_STORAGE_TIMEOUT,
        spawn_blocking(move || delete_remote_secrets(secure_storage_key)),
    )
    .await
    .map_err(|_| DaemonError::Process("timed out deleting persisted remote secrets".to_string()))?
    .map_err(|error| DaemonError::Process(format!("secure storage task failed: {error}")))?
}

/// macOS Keychain access can block indefinitely when the app signature or ACL
/// changes between builds. Remote connectivity must not depend on an
/// interactive credential-store prompt, so the desktop defaults to an atomic
/// owner-only file beside the daemon state. Headless hosts can opt into the
/// same backend with `FALCONDECK_SECRET_FILE`.
#[cfg(not(test))]
fn secret_file_path() -> Option<std::path::PathBuf> {
    let configured = std::env::var("FALCONDECK_SECRET_FILE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(std::path::PathBuf::from);
    if configured.is_some() {
        return configured;
    }

    #[cfg(target_os = "macos")]
    {
        return Some(
            default_state_path()
                .parent()
                .unwrap_or_else(|| Path::new("."))
                .join("remote-secrets.json"),
        );
    }

    #[cfg(not(target_os = "macos"))]
    None
}

fn read_secret_file(
    path: &std::path::Path,
) -> Result<std::collections::HashMap<String, String>, DaemonError> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(std::collections::HashMap::new());
        }
        Err(error) => {
            return Err(DaemonError::Process(format!(
                "failed to read secret file: {error}"
            )));
        }
    };
    serde_json::from_str(&raw)
        .map_err(|error| DaemonError::BadRequest(format!("invalid secret file: {error}")))
}

fn write_secret_file(
    path: &std::path::Path,
    entries: &std::collections::HashMap<String, String>,
) -> Result<(), DaemonError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            DaemonError::Process(format!("failed to create secret dir: {error}"))
        })?;
    }
    let payload = serde_json::to_string(entries)?;
    let tmp_path = path.with_extension(format!("tmp.{}", uuid::Uuid::new_v4().simple()));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options
        .open(&tmp_path)
        .map_err(|error| DaemonError::Process(format!("failed to create secret file: {error}")))?;
    if let Err(error) = file
        .write_all(payload.as_bytes())
        .and_then(|()| file.sync_all())
    {
        drop(file);
        let _ = std::fs::remove_file(&tmp_path);
        return Err(DaemonError::Process(format!(
            "failed to write secret file: {error}"
        )));
    }
    drop(file);
    if let Err(error) = std::fs::rename(&tmp_path, path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(DaemonError::Process(format!(
            "failed to publish secret file: {error}"
        )));
    }
    #[cfg(unix)]
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| DaemonError::Process(format!("failed to secure secret file: {error}")))?;
    Ok(())
}

#[cfg(not(test))]
pub(super) fn save_remote_secrets_to_secure_storage(
    secure_storage_key: &str,
    secrets: &PersistedRemoteSecrets,
) -> Result<(), DaemonError> {
    let payload = serde_json::to_string(secrets)?;
    if let Some(path) = secret_file_path() {
        let mut entries = read_secret_file(&path)?;
        entries.insert(secure_storage_key.to_string(), payload);
        return write_secret_file(&path, &entries);
    }
    let entry = keyring::Entry::new("com.falcondeck.daemon.remote", secure_storage_key)
        .map_err(|error| DaemonError::Process(format!("failed to open secure storage: {error}")))?;
    match entry.set_password(&payload) {
        Ok(()) => Ok(()),
        Err(first_error) => {
            // On macOS an item created by a differently-signed binary (e.g.
            // the packaged app vs. a dev build) can't be updated in place:
            // the add hits errSecDuplicateItem while the update is denied.
            // Recreating the item under our own signature recovers it.
            entry.delete_credential().map_err(|delete_error| {
                DaemonError::Process(format!(
                    "failed to write secure storage: {first_error} (and could not replace existing item: {delete_error})"
                ))
            })?;
            entry.set_password(&payload).map_err(|error| {
                DaemonError::Process(format!("failed to write secure storage: {error}"))
            })
        }
    }
}

#[cfg(not(test))]
pub(super) fn load_remote_secrets_from_secure_storage(
    secure_storage_key: &str,
) -> Result<PersistedRemoteSecrets, DaemonError> {
    if let Some(path) = secret_file_path() {
        let entries = read_secret_file(&path)?;
        let payload = entries
            .get(secure_storage_key)
            .ok_or_else(|| DaemonError::NotFound("no persisted remote secrets".to_string()))?;
        return serde_json::from_str::<PersistedRemoteSecrets>(payload).map_err(|error| {
            DaemonError::BadRequest(format!("invalid secret file payload: {error}"))
        });
    }
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
    if let Some(path) = secret_file_path() {
        let mut entries = read_secret_file(&path)?;
        if entries.remove(secure_storage_key).is_some() {
            write_secret_file(&path, &entries)?;
        }
        return Ok(());
    }
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
    use falcondeck_core::crypto::{LocalBoxKeyPair, build_pairing_public_key_bundle};
    use serde::de::value::{SeqDeserializer, StringDeserializer};
    use serde_json::json;

    use crate::app::PersistedWorkspaceState;

    #[tokio::test]
    async fn atomic_state_files_are_owner_only() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("daemon-state.json");

        write_atomically(&path, b"{\"ok\":true}".to_vec())
            .await
            .unwrap();

        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"ok\":true}");
        #[cfg(unix)]
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn secret_file_writes_are_atomic_and_owner_only() {
        let temp_dir = tempfile::tempdir().unwrap();
        let path = temp_dir.path().join("remote-secrets.json");
        let entries = std::collections::HashMap::from([
            ("session-a".to_string(), "secret-a".to_string()),
            ("session-b".to_string(), "secret-b".to_string()),
        ]);

        write_secret_file(&path, &entries).unwrap();

        assert_eq!(read_secret_file(&path).unwrap(), entries);
        #[cfg(unix)]
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::read_dir(temp_dir.path()).unwrap().count(),
            1,
            "atomic write should not leave a temporary file behind"
        );
    }

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
                    default_provider: Some(AgentProvider::CODEX),
                    last_error: None,
                    archived_thread_ids: Vec::new(),
                    pinned_thread_ids: Vec::new(),
                    thread_states: Vec::new(),
                },
                PersistedWorkspaceState {
                    path: "/tmp/project-b".to_string(),
                    current_thread_id: None,
                    updated_at: None,
                    default_provider: Some(AgentProvider::CODEX),
                    last_error: None,
                    archived_thread_ids: Vec::new(),
                    pinned_thread_ids: Vec::new(),
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
                trusted_client_bundles: Vec::new(),
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
            trusted_client_bundles: Vec::new(),
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
            trusted_client_bundles: Vec::new(),
        };

        let reason = invalid_persisted_remote_reason(&remote).unwrap();
        assert!(reason.contains("invalid signed client key material"));
    }

    #[test]
    fn allows_trusted_remote_without_signed_client_material_when_not_legacy() {
        let remote = PersistedRemoteState {
            relay_url: "https://connect.falcondeck.com".to_string(),
            daemon_token: "daemon-token".to_string(),
            pairing_id: "pairing-1".to_string(),
            pairing_code: "ABCDEFGHJKLM".to_string(),
            session_id: Some("session-1".to_string()),
            device_id: Some("device-1".to_string()),
            trusted_at: Some(Utc::now()),
            expires_at: Utc::now() + Duration::minutes(10),
            client_bundle: None,
            client_public_key: None,
            secure_storage_key: None,
            local_secret_key_base64: None,
            data_key_base64: None,
            trusted_client_bundles: Vec::new(),
        };

        assert!(invalid_persisted_remote_reason(&remote).is_none());
    }
}

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::PathBuf,
    process::Stdio,
    sync::Arc,
};

use falcondeck_core::{
    ExtensionThreadSummary, ExtensionViewScope,
    orchestration::{ExtensionOrchestrationEffect, ExtensionRunSummary},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::Mutex,
    time::{Duration, timeout},
};

use super::extensions::{ExtensionPackage, PublishedExtensionView};
use crate::{agent_binary::resolve_agent_binary, error::DaemonError};

const HOST_ACTION_TIMEOUT: Duration = Duration::from_secs(10);
const HOST_EVENT_TIMEOUT: Duration = Duration::from_secs(5);
pub(super) const MAX_EXTENSION_EVENT_BYTES: usize = 4 * 1024;
const MAX_HOST_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_SAFE_JAVASCRIPT_INTEGER: u64 = 9_007_199_254_740_991;

pub(super) struct ExtensionHostPool {
    state_path: PathBuf,
    deno_bin: String,
    hosts: HashMap<String, Arc<Mutex<ExtensionHost>>>,
}

impl ExtensionHostPool {
    pub(super) fn new(state_path: PathBuf, deno_bin: String) -> Self {
        Self {
            state_path,
            deno_bin,
            hosts: HashMap::new(),
        }
    }

    pub(super) fn host(&mut self, extension_id: &str) -> Arc<Mutex<ExtensionHost>> {
        self.hosts
            .entry(extension_id.to_string())
            .or_insert_with(|| {
                Arc::new(Mutex::new(ExtensionHost::new(
                    &self.state_path,
                    self.deno_bin.clone(),
                )))
            })
            .clone()
    }

    pub(super) fn remove(&mut self, extension_id: &str) -> Option<Arc<Mutex<ExtensionHost>>> {
        self.hosts.remove(extension_id)
    }

    pub(super) fn drain(&mut self) -> Vec<Arc<Mutex<ExtensionHost>>> {
        self.hosts.drain().map(|(_, host)| host).collect()
    }
}

pub(super) struct ExtensionHost {
    process: Option<HostProcess>,
    next_request_id: u64,
    state_dir: PathBuf,
    allowed_package_roots: BTreeSet<PathBuf>,
    deno_bin: String,
}

struct HostProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostActionRequest<'a> {
    request_id: u64,
    method: &'static str,
    extension_id: &'a str,
    entrypoint: String,
    action_id: &'a str,
    target: Option<&'a ExtensionViewScope>,
    input: &'a Value,
    storage: &'a BTreeMap<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_summaries: Option<&'a [ExtensionThreadSummary]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    orchestration_runs: Option<&'a [ExtensionRunSummary]>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostToolRequest<'a> {
    request_id: u64,
    method: &'static str,
    extension_id: &'a str,
    entrypoint: String,
    tool_id: &'a str,
    arguments: &'a Value,
    /// Daemon-supplied call context. Agents never choose which thread a tool
    /// call lands on; the harness spawn decides it.
    thread_id: Option<&'a str>,
    workspace_id: Option<&'a str>,
    storage: &'a BTreeMap<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_summaries: Option<&'a [ExtensionThreadSummary]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    orchestration_runs: Option<&'a [ExtensionRunSummary]>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub(super) enum ExtensionEvent {
    #[serde(rename = "thread.updated")]
    ThreadUpdated {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
    },
    #[serde(rename = "turn.start")]
    TurnStarted {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "turnId")]
        turn_id: String,
    },
    #[serde(rename = "turn.ended")]
    TurnEnded {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "turnId")]
        turn_id: String,
    },
    #[serde(rename = "attention.opened")]
    AttentionOpened {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "threadId", skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(rename = "requestId")]
        request_id: String,
    },
    #[serde(rename = "attention.resolved")]
    AttentionResolved {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "threadId", skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        #[serde(rename = "requestId")]
        request_id: String,
    },
    #[serde(rename = "orchestration.updated")]
    OrchestrationUpdated {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        #[serde(rename = "runId")]
        run_id: String,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct HostEventRequest<'a> {
    request_id: u64,
    method: &'static str,
    extension_id: &'a str,
    entrypoint: String,
    event: &'a ExtensionEvent,
    storage: &'a BTreeMap<String, Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_summaries: Option<&'a [ExtensionThreadSummary]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    orchestration_runs: Option<&'a [ExtensionRunSummary]>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HostActionResponse {
    request_id: u64,
    ok: bool,
    #[serde(default)]
    result: Value,
    #[serde(default)]
    storage: BTreeMap<String, Value>,
    #[serde(default)]
    published_views: Vec<PublishedExtensionView>,
    #[serde(default)]
    orchestration_effects: Vec<ExtensionOrchestrationEffect>,
    #[serde(default)]
    error: Option<String>,
}

/// Why a tool call did not produce a result.
///
/// Agent-facing tools are called by models, which routinely pass arguments an
/// extension rejects. A rejection is normal traffic and must not mark the
/// extension broken; only a host that died, timed out, or spoke the protocol
/// wrongly is an extension failure worth surfacing in Settings.
#[derive(Debug)]
pub(super) enum ExtensionToolError {
    /// Extension code raised. The message goes back to the calling agent.
    Rejected(String),
    /// The host itself failed.
    Failed(DaemonError),
}

/// Wraps a host-level failure, which is always an extension failure.
fn fail(error: DaemonError) -> ExtensionToolError {
    ExtensionToolError::Failed(error)
}

impl From<ExtensionToolError> for DaemonError {
    fn from(error: ExtensionToolError) -> Self {
        match error {
            ExtensionToolError::Rejected(message) => DaemonError::BadRequest(message),
            ExtensionToolError::Failed(error) => error,
        }
    }
}

#[derive(Debug)]
pub(super) struct ExtensionHostActionResult {
    pub(super) result: Value,
    pub(super) storage: BTreeMap<String, Value>,
    pub(super) published_views: Vec<PublishedExtensionView>,
    pub(super) orchestration_effects: Vec<ExtensionOrchestrationEffect>,
}

impl ExtensionHost {
    pub(super) fn new(daemon_state_path: &std::path::Path, deno_bin: String) -> Self {
        Self {
            process: None,
            next_request_id: 1,
            state_dir: daemon_state_path
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."))
                .to_path_buf(),
            allowed_package_roots: BTreeSet::new(),
            deno_bin,
        }
    }

    /// Makes sure a live host process exists and is allowed to read this
    /// package's root. A newly seen root needs a restart because the Deno
    /// read allowlist is fixed at spawn.
    async fn prepare(&mut self, package: &ExtensionPackage) -> Result<(), DaemonError> {
        let package_root = package
            .entrypoint
            .parent()
            .ok_or_else(|| {
                DaemonError::Process("extension entrypoint has no package root".to_string())
            })?
            .to_path_buf();
        if self.allowed_package_roots.insert(package_root) && self.process.is_some() {
            self.stop().await;
        }
        self.ensure_started().await
    }

    fn take_request_id(&mut self) -> u64 {
        let request_id = self.next_request_id;
        self.next_request_id = if request_id >= MAX_SAFE_JAVASCRIPT_INTEGER {
            1
        } else {
            request_id + 1
        };
        request_id
    }

    pub(super) async fn invoke(
        &mut self,
        package: &ExtensionPackage,
        action_id: &str,
        target: Option<&ExtensionViewScope>,
        input: &Value,
        storage: &BTreeMap<String, Value>,
        thread_summaries: Option<&[ExtensionThreadSummary]>,
        orchestration_runs: Option<&[ExtensionRunSummary]>,
    ) -> Result<ExtensionHostActionResult, DaemonError> {
        self.prepare(package).await?;
        let request_id = self.take_request_id();
        let request = HostActionRequest {
            request_id,
            method: "action.invoke",
            extension_id: &package.id,
            entrypoint: package.entrypoint.to_string_lossy().into_owned(),
            action_id,
            target,
            input,
            storage,
            thread_summaries,
            orchestration_runs,
        };
        let response = self
            .send_request(&request, request_id, HOST_ACTION_TIMEOUT, "action")
            .await?;
        Ok(ExtensionHostActionResult {
            result: response.result,
            storage: response.storage,
            published_views: response.published_views,
            orchestration_effects: response.orchestration_effects,
        })
    }

    /// Routes one agent tool call into the extension's isolated host, using
    /// the same storage/publication commit path as an action.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn invoke_tool(
        &mut self,
        package: &ExtensionPackage,
        tool_id: &str,
        arguments: &Value,
        thread_id: Option<&str>,
        workspace_id: Option<&str>,
        storage: &BTreeMap<String, Value>,
        thread_summaries: Option<&[ExtensionThreadSummary]>,
        orchestration_runs: Option<&[ExtensionRunSummary]>,
    ) -> Result<ExtensionHostActionResult, ExtensionToolError> {
        self.prepare(package)
            .await
            .map_err(ExtensionToolError::Failed)?;
        let request_id = self.take_request_id();
        let request = HostToolRequest {
            request_id,
            method: "tool.invoke",
            extension_id: &package.id,
            entrypoint: package.entrypoint.to_string_lossy().into_owned(),
            tool_id,
            arguments,
            thread_id,
            workspace_id,
            storage,
            thread_summaries,
            orchestration_runs,
        };
        let response = self
            .send_request(&request, request_id, HOST_ACTION_TIMEOUT, "tool")
            .await?;
        Ok(ExtensionHostActionResult {
            result: response.result,
            storage: response.storage,
            published_views: response.published_views,
            orchestration_effects: response.orchestration_effects,
        })
    }

    pub(super) async fn dispatch_event(
        &mut self,
        package: &ExtensionPackage,
        event: &ExtensionEvent,
        storage: &BTreeMap<String, Value>,
        thread_summaries: Option<&[ExtensionThreadSummary]>,
        orchestration_runs: Option<&[ExtensionRunSummary]>,
    ) -> Result<ExtensionHostActionResult, DaemonError> {
        if serde_json::to_vec(event)?.len() > MAX_EXTENSION_EVENT_BYTES {
            return Err(DaemonError::BadRequest(format!(
                "extension event exceeds {MAX_EXTENSION_EVENT_BYTES} bytes"
            )));
        }
        self.prepare(package).await?;
        let request_id = self.take_request_id();
        let request = HostEventRequest {
            request_id,
            method: "event.dispatch",
            extension_id: &package.id,
            entrypoint: package.entrypoint.to_string_lossy().into_owned(),
            event,
            storage,
            thread_summaries,
            orchestration_runs,
        };
        let response = self
            .send_request(&request, request_id, HOST_EVENT_TIMEOUT, "event")
            .await?;
        Ok(ExtensionHostActionResult {
            result: response.result,
            storage: response.storage,
            published_views: response.published_views,
            orchestration_effects: response.orchestration_effects,
        })
    }

    async fn send_request(
        &mut self,
        request: &impl Serialize,
        request_id: u64,
        request_timeout: Duration,
        operation: &str,
    ) -> Result<HostActionResponse, ExtensionToolError> {
        let line = serde_json::to_vec(request).map_err(|error| fail(error.into()))?;
        let process = self.process.as_mut().ok_or_else(|| {
            fail(DaemonError::Process(
                "extension host unavailable".to_string(),
            ))
        })?;
        let response = timeout(request_timeout, async {
            process.stdin.write_all(&line).await?;
            process.stdin.write_all(b"\n").await?;
            process.stdin.flush().await?;
            let response_line = read_bounded_line(&mut process.stdout).await?;
            serde_json::from_slice::<HostActionResponse>(&response_line).map_err(DaemonError::from)
        })
        .await;

        let response = match response {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => {
                self.stop().await;
                return Err(fail(error));
            }
            Err(_) => {
                self.stop().await;
                return Err(fail(DaemonError::Process(format!(
                    "extension {operation} timed out"
                ))));
            }
        };
        if response.request_id != request_id {
            self.stop().await;
            return Err(fail(DaemonError::Process(
                "extension host returned a mismatched request id".to_string(),
            )));
        }
        if !response.ok {
            // Extension code raised and the host is still healthy.
            return Err(ExtensionToolError::Rejected(
                response
                    .error
                    .unwrap_or_else(|| format!("extension {operation} failed")),
            ));
        }
        Ok(response)
    }

    async fn ensure_started(&mut self) -> Result<(), DaemonError> {
        if let Some(process) = self.process.as_mut()
            && let Ok(None) = process.child.try_wait()
        {
            return Ok(());
        }
        self.process = None;
        let script = extension_host_script(&self.state_dir);
        let sdk_root = self.state_dir.join("packages/extension-sdk");
        let import_map = self.state_dir.join("extension-host/import-map.json");
        let mut allowed_reads = self
            .allowed_package_roots
            .iter()
            .cloned()
            .collect::<Vec<_>>();
        allowed_reads.push(script.clone());
        allowed_reads.push(sdk_root);
        allowed_reads.push(import_map.clone());
        let allowed_reads = deno_read_allowlist(&allowed_reads)?;
        let import_map = import_map.to_str().ok_or_else(|| {
            DaemonError::Process("extension host import-map path is not valid UTF-8".to_string())
        })?;
        let deno = resolve_agent_binary("deno", &self.deno_bin);
        let mut child = Command::new(&deno.executable)
            .arg("run")
            .arg("--quiet")
            .arg("--no-config")
            .arg(format!("--import-map={import_map}"))
            .arg(format!("--allow-read={allowed_reads}"))
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|error| {
                DaemonError::Process(format!(
                    "failed to start Deno extension host at {}: {error}",
                    deno.executable
                ))
            })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| DaemonError::Process("extension host stdin unavailable".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| DaemonError::Process("extension host stdout unavailable".to_string()))?;
        self.process = Some(HostProcess {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        });
        Ok(())
    }

    pub(super) async fn stop(&mut self) {
        if let Some(mut process) = self.process.take() {
            let _ = process.child.kill().await;
            let _ = process.child.wait().await;
        }
    }
}

fn deno_read_allowlist(paths: &[PathBuf]) -> Result<String, DaemonError> {
    paths
        .iter()
        .map(|path| {
            let path = path.to_str().ok_or_else(|| {
                DaemonError::Process(
                    "extension host read permission path is not valid UTF-8".to_string(),
                )
            })?;
            // Deno parses --allow-read as a comma-delimited list and offers no
            // escaping for literal commas. Failing early avoids granting access
            // to unintended path fragments and produces an actionable error.
            if path.contains(',') {
                return Err(DaemonError::Process(
                    "extension paths containing commas are not supported by the Deno host"
                        .to_string(),
                ));
            }
            Ok(path)
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|paths| paths.join(","))
}

async fn read_bounded_line(
    reader: &mut (impl AsyncBufRead + Unpin),
) -> Result<Vec<u8>, DaemonError> {
    let mut line = Vec::new();
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            if line.is_empty() {
                return Err(DaemonError::Process(
                    "extension host closed its output".to_string(),
                ));
            }
            return Ok(line);
        }
        let consumed = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |index| index + 1);
        if line.len().saturating_add(consumed) > MAX_HOST_RESPONSE_BYTES {
            return Err(DaemonError::Process(format!(
                "extension host response exceeds {MAX_HOST_RESPONSE_BYTES} bytes"
            )));
        }
        line.extend_from_slice(&available[..consumed]);
        let complete = available[consumed - 1] == b'\n';
        reader.consume(consumed);
        if complete {
            return Ok(line);
        }
    }
}

fn extension_host_script(state_dir: &std::path::Path) -> PathBuf {
    std::env::var_os("FALCONDECK_EXTENSION_HOST")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let repository_script =
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../apps/extension-host/main.ts");
            if repository_script.is_file() {
                repository_script
            } else {
                state_dir.join("extension-host/main.ts")
            }
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use falcondeck_core::{
        InvokeExtensionActionRequest, ThreadStatus,
        orchestration::{
            ExtensionOrchestrationEffect, ExtensionRunGate, ExtensionRunSummary,
            MAX_AUTOMATIC_TURNS,
        },
    };

    #[test]
    fn host_pool_reuses_one_host_per_extension_and_isolates_others() {
        let state_path = std::env::temp_dir().join("falcondeck-host-pool/state.json");
        let mut pool = ExtensionHostPool::new(state_path, "deno".to_string());
        let first = pool.host("one");
        let first_again = pool.host("one");
        let second = pool.host("two");

        assert!(Arc::ptr_eq(&first, &first_again));
        assert!(!Arc::ptr_eq(&first, &second));
    }

    #[tokio::test]
    async fn official_follow_ups_publishes_and_clears_through_the_tool_contract() {
        let deno = resolve_agent_binary("deno", "deno").executable;
        if Command::new(deno).arg("--version").output().await.is_err() {
            return;
        }
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let package = ExtensionPackage {
            id: "falcondeck.follow-up-suggestions".to_string(),
            entrypoint: root.join("extensions/official/follow-up-suggestions/server.ts"),
        };
        let state_path = std::env::temp_dir().join("falcondeck-follow-ups-host-test/state.json");
        let mut registry = super::super::extensions::ExtensionRegistry::new(&state_path);
        registry
            .restore()
            .await
            .expect("runtime support assets should restore");
        let mut host = ExtensionHost::new(&state_path, "deno".to_string());

        let published = host
            .invoke_tool(
                &package,
                "suggest-follow-ups",
                &serde_json::json!({
                    "actions": [
                        { "id": "ship", "label": "Ship it", "prompt": "Open a pull request." },
                        { "id": "test", "label": "Run the tests", "prompt": "Run the suite." }
                    ],
                    "preferredActionId": "test"
                }),
                Some("thread-1"),
                Some("workspace-1"),
                &BTreeMap::new(),
                None,
                None,
            )
            .await
            .expect("a bounded offer set should publish");
        assert_eq!(
            published.result,
            serde_json::json!({ "published": true, "count": 2 })
        );
        let view = published
            .published_views
            .first()
            .expect("the tool should publish one thread-scoped view");
        assert_eq!(view.view_id, "follow-ups");
        assert_eq!(
            view.scope.as_ref().map(|scope| scope.kind.as_str()),
            Some("thread")
        );
        assert_eq!(
            view.value.get("preferredActionId"),
            Some(&serde_json::json!("test"))
        );

        // A model passing a label the contract rejects is a rejection, not an
        // extension failure: the host stays up to serve the next call.
        let rejected = host
            .invoke_tool(
                &package,
                "suggest-follow-ups",
                &serde_json::json!({
                    "actions": [{ "id": "a", "label": "x".repeat(31), "prompt": "Do it." }]
                }),
                Some("thread-1"),
                None,
                &published.storage,
                None,
                None,
            )
            .await
            .expect_err("an over-long label must be refused");
        assert!(matches!(rejected, ExtensionToolError::Rejected(_)));

        host.stop().await;
        // Staleness is the daemon's rule, not the extension's, so this
        // package stores nothing between calls.
        assert!(published.storage.is_empty());
    }

    #[tokio::test]
    async fn official_missions_uses_only_the_public_run_facet() {
        let deno = resolve_agent_binary("deno", "deno").executable;
        if Command::new(deno).arg("--version").output().await.is_err() {
            return;
        }
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let package = ExtensionPackage {
            id: "falcondeck.missions".to_string(),
            entrypoint: root.join("extensions/official/missions/server.ts"),
        };
        let state_path = std::env::temp_dir().join("falcondeck-missions-host-test/state.json");
        let mut registry = super::super::extensions::ExtensionRegistry::new(&state_path);
        registry
            .restore()
            .await
            .expect("runtime support assets should restore");
        let mut host = ExtensionHost::new(&state_path, "deno".to_string());
        let now = chrono::Utc::now();
        let runs = [ExtensionRunSummary {
            id: "run-1".to_string(),
            owner_extension_id: "falcondeck.missions".to_string(),
            workspace_id: "workspace-1".to_string(),
            coordinator_thread_id: "thread-1".to_string(),
            title: "Mission test".to_string(),
            objective: "Prove the public extension contract".to_string(),
            gate: ExtensionRunGate::Open,
            outcome: None,
            pause_reason: None,
            checkpoint: serde_json::json!({
                "schemaVersion": 1,
                "objective": "Prove the public extension contract",
                "acceptanceCriteria": ["A checkpoint is emitted"],
                "disposition": "planning",
                "summary": "",
                "evidence": [],
                "limitations": [],
                "updatedAt": now,
            }),
            policy_revision: 3,
            journal_sequence: 2,
            approval_generation: 1,
            automatic_turns_started: 1,
            max_automatic_turns: MAX_AUTOMATIC_TURNS,
            max_workers: falcondeck_core::orchestration::MAX_MANAGED_WORKERS,
            awaiting_workers: false,
            created_at: now,
            updated_at: now,
            deadline_at: now + chrono::Duration::minutes(30),
            last_progress_fingerprint: None,
            pending_continuation: None,
            completion_proposed: false,
            operations: Vec::new(),
            workers: Vec::new(),
        }];
        let threads = [ExtensionThreadSummary {
            id: "thread-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            title: "Mission test".to_string(),
            provider: falcondeck_core::AgentProvider::CLAUDE,
            status: ThreadStatus::Running,
            updated_at: now,
            pending_approval_count: 0,
            pending_question_count: 0,
        }];

        let refreshed = host
            .invoke(
                &package,
                "refresh-missions",
                None,
                &serde_json::json!({}),
                &BTreeMap::new(),
                Some(&threads),
                Some(&runs),
            )
            .await
            .expect("Missions panel should render through the public host");
        assert_eq!(refreshed.published_views[0].view_id, "missions-panel");
        assert!(refreshed.orchestration_effects.is_empty());

        let checkpointed = host
            .invoke_tool(
                &package,
                "mission-checkpoint",
                &serde_json::json!({
                    "disposition": "continue_self",
                    "summary": "Recorded a durable checkpoint",
                    "nextAction": "Run the focused test",
                    "progressFingerprint": "checkpoint-v1",
                    "evidence": [],
                    "limitations": []
                }),
                Some("thread-1"),
                Some("workspace-1"),
                &refreshed.storage,
                Some(&threads),
                Some(&runs),
            )
            .await
            .expect("coordinator checkpoint should return one broker effect");
        assert!(matches!(
            checkpointed.orchestration_effects.as_slice(),
            [ExtensionOrchestrationEffect::RequestContinuation {
                run_id,
                expected_policy_revision: 3,
                progress_fingerprint,
                ..
            }] if run_id == "run-1" && progress_fingerprint == "checkpoint-v1"
        ));
        host.stop().await;
    }

    #[tokio::test]
    async fn official_thread_tags_runs_through_public_host_contract() {
        let deno = resolve_agent_binary("deno", "deno").executable;
        if Command::new(deno).arg("--version").output().await.is_err() {
            return;
        }
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let package = ExtensionPackage {
            id: "falcondeck.thread-tags".to_string(),
            entrypoint: root.join("extensions/official/thread-tags/server.ts"),
        };
        let state_path = std::env::temp_dir().join("falcondeck-extension-host-test/state.json");
        let mut registry = super::super::extensions::ExtensionRegistry::new(&state_path);
        registry
            .restore()
            .await
            .expect("runtime support assets should restore");
        let mut host = ExtensionHost::new(&state_path, "deno".to_string());
        let legacy_storage = BTreeMap::from([
            (
                "tags".to_string(),
                serde_json::json!([{ "id": "legacy-red", "label": "Urgent", "color": "red" }]),
            ),
            (
                "assignments".to_string(),
                serde_json::json!({ "thread-1": ["legacy-red"] }),
            ),
        ]);
        let migrated = host
            .invoke(
                &package,
                "manage-tags",
                None,
                &serde_json::json!({ "operation": "read" }),
                &legacy_storage,
                None,
                None,
            )
            .await
            .expect("legacy colour labels should be dropped");
        assert_eq!(
            migrated.storage.get("threadStages"),
            Some(&serde_json::json!({}))
        );
        assert!(migrated.storage.contains_key("stages"));
        assert!(!migrated.storage.contains_key("tags"));
        assert!(!migrated.storage.contains_key("assignments"));
        assert!(!migrated.storage.contains_key("threadColors"));
        let result = host
            .invoke(
                &package,
                "manage-tags",
                Some(&ExtensionViewScope {
                    kind: "thread".to_string(),
                    id: "thread-1".to_string(),
                }),
                &serde_json::json!({
                    "operation": "set_thread_stage",
                    "stageId": "in_progress"
                }),
                &migrated.storage,
                None,
                None,
            )
            .await
            .expect("thread stages action should run");
        host.stop().await;
        assert_eq!(
            result.storage.get("threadStages"),
            Some(&serde_json::json!({ "thread-1": "in_progress" }))
        );
        assert!(
            result
                .published_views
                .iter()
                .any(|view| view.view_id == "tag-index")
        );
        assert!(result.published_views.iter().any(|view| {
            view.view_id == "thread-tags"
                && view
                    .scope
                    .as_ref()
                    .is_some_and(|scope| scope.id == "thread-1")
        }));
    }

    #[tokio::test]
    async fn lifecycle_event_runs_through_public_host_contract() {
        let deno = resolve_agent_binary("deno", "deno").executable;
        if Command::new(deno).arg("--version").output().await.is_err() {
            return;
        }
        let state_dir = tempfile::tempdir().expect("temporary host state");
        let state_path = state_dir.path().join("state.json");
        let mut registry = super::super::extensions::ExtensionRegistry::new(&state_path);
        registry
            .restore()
            .await
            .expect("runtime support assets should restore");
        let package_dir = state_dir.path().join("event-extension");
        tokio::fs::create_dir_all(&package_dir)
            .await
            .expect("fixture package should create");
        let entrypoint = package_dir.join("server.ts");
        tokio::fs::write(
            &entrypoint,
            r#"
import { defineExtension } from '@falcondeck/extension-sdk'
export default defineExtension({
  activate(context) {
    context.events.on('thread.updated', async ({ threadId }) => {
      const threads = await context.threads.list()
      const thread = threads.find((candidate) => candidate.id === threadId)
      await context.storage.set('threadId', threadId)
      await context.views.publish({
        viewId: 'latest',
        value: { threadId, title: thread?.title ?? null },
      })
    })
  },
})
"#,
        )
        .await
        .expect("fixture extension should write");
        let package = ExtensionPackage {
            id: "test.events".to_string(),
            entrypoint,
        };
        let event = ExtensionEvent::ThreadUpdated {
            workspace_id: "workspace-1".to_string(),
            thread_id: "thread-1".to_string(),
        };
        let mut host = ExtensionHost::new(&state_path, "deno".to_string());
        let summaries = [ExtensionThreadSummary {
            id: "thread-1".to_string(),
            workspace_id: "workspace-1".to_string(),
            title: "Needs review".to_string(),
            provider: falcondeck_core::AgentProvider::CLAUDE,
            status: ThreadStatus::WaitingForInput,
            updated_at: chrono::Utc::now(),
            pending_approval_count: 1,
            pending_question_count: 0,
        }];
        let denied = match host
            .dispatch_event(&package, &event, &BTreeMap::new(), None, None)
            .await
        {
            Ok(_) => panic!("thread reads must be denied without a grant projection"),
            Err(error) => error,
        };
        assert!(
            denied
                .to_string()
                .contains("threads:read permission is not granted")
        );
        let result = host
            .dispatch_event(&package, &event, &BTreeMap::new(), Some(&summaries), None)
            .await
            .expect("event should run");
        host.stop().await;

        assert_eq!(
            result.storage.get("threadId"),
            Some(&serde_json::json!("thread-1"))
        );
        assert_eq!(result.published_views.len(), 1);
        let published = &result.published_views[0];
        assert_eq!(published.view_id, "latest");
        assert_eq!(published.scope, None);
        assert_eq!(
            published.value,
            serde_json::json!({ "threadId": "thread-1", "title": "Needs review" })
        );
    }

    #[tokio::test]
    async fn bounded_line_rejects_oversized_host_output() {
        let (mut writer, reader) = tokio::io::duplex(MAX_HOST_RESPONSE_BYTES * 2);
        let writer_task = tokio::spawn(async move {
            writer
                .write_all(&vec![b'x'; MAX_HOST_RESPONSE_BYTES + 1])
                .await
                .expect("fixture output should write");
        });
        let mut reader = BufReader::new(reader);
        let error = read_bounded_line(&mut reader)
            .await
            .expect_err("oversized host output must fail");
        writer_task.await.expect("fixture writer should finish");
        assert!(error.to_string().contains("response exceeds"));
    }

    #[test]
    fn deno_read_allowlist_rejects_ambiguous_comma_paths() {
        let error = deno_read_allowlist(&[PathBuf::from("/tmp/extensions,other")])
            .expect_err("comma paths must not expand Deno's permission list");
        assert!(error.to_string().contains("containing commas"));
    }

    #[tokio::test]
    async fn extension_console_log_does_not_corrupt_host_protocol() {
        let deno = resolve_agent_binary("deno", "deno").executable;
        if Command::new(deno).arg("--version").output().await.is_err() {
            return;
        }
        let state_dir = tempfile::tempdir().expect("temporary host state");
        let state_path = state_dir.path().join("state.json");
        let mut registry = super::super::extensions::ExtensionRegistry::new(&state_path);
        registry
            .restore()
            .await
            .expect("runtime support assets should restore");
        let package_dir = state_dir.path().join("logging-extension");
        tokio::fs::create_dir_all(&package_dir)
            .await
            .expect("fixture package should create");
        let entrypoint = package_dir.join("server.ts");
        tokio::fs::write(
            &entrypoint,
            r#"
import { defineExtension } from '@falcondeck/extension-sdk'
export default defineExtension({
  activate(context) {
    console.log('activation diagnostic')
    context.actions.register('run', () => {
      console.log('action diagnostic')
      const fields: Record<string, unknown> = {}
      fields.self = fields
      context.log.info('cyclic diagnostic', fields)
      return { ok: true }
    })
  },
})
"#,
        )
        .await
        .expect("fixture extension should write");
        let package = ExtensionPackage {
            id: "test.logging".to_string(),
            entrypoint,
        };
        let mut host = ExtensionHost::new(&state_path, "deno".to_string());
        let result = host
            .invoke(
                &package,
                "run",
                None,
                &Value::Null,
                &BTreeMap::new(),
                None,
                None,
            )
            .await
            .expect("console diagnostics must stay off protocol stdout");
        host.stop().await;
        assert_eq!(result.result, serde_json::json!({ "ok": true }));
    }

    #[tokio::test]
    async fn concurrent_stage_actions_preserve_both_thread_updates() {
        let deno = resolve_agent_binary("deno", "deno").executable;
        if Command::new(deno).arg("--version").output().await.is_err() {
            return;
        }
        let state_dir = tempfile::tempdir().expect("temporary daemon state");
        let app = crate::app::AppState::new_with_state_path(
            "test".to_string(),
            std::collections::HashMap::new(),
            state_dir.path().join("state.json"),
        );
        app.restore_local_state()
            .await
            .expect("extension registry should restore");

        let assign = |thread_id: &str, stage_id: &str| {
            app.invoke_extension_action(
                "falcondeck.thread-tags",
                "manage-tags",
                InvokeExtensionActionRequest {
                    target: Some(ExtensionViewScope {
                        kind: "thread".to_string(),
                        id: thread_id.to_string(),
                    }),
                    input: serde_json::json!({
                        "operation": "set_thread_stage",
                        "stageId": stage_id,
                    }),
                },
            )
        };
        let (first, second) = tokio::join!(
            assign("thread-1", "in_progress"),
            assign("thread-2", "done")
        );
        first.expect("first stage should save");
        second.expect("second stage should save");

        let snapshot = app.extension_snapshot().await;
        for thread_id in ["thread-1", "thread-2"] {
            assert!(snapshot.views.iter().any(|view| {
                view.view_id == "thread-tags"
                    && view
                        .scope
                        .as_ref()
                        .is_some_and(|scope| scope.id == thread_id)
            }));
        }

        let restored = crate::app::AppState::new_with_state_path(
            "test".to_string(),
            std::collections::HashMap::new(),
            state_dir.path().join("state.json"),
        );
        restored
            .restore_local_state()
            .await
            .expect("saved extension views should restore");
        assert_eq!(restored.extension_snapshot().await.views.len(), 3);
    }
}

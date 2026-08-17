use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    path::PathBuf,
    process::Stdio,
    sync::Arc,
};

use falcondeck_core::{ExtensionThreadSummary, ExtensionViewScope};
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
    error: Option<String>,
}

pub(super) struct ExtensionHostActionResult {
    pub(super) result: Value,
    pub(super) storage: BTreeMap<String, Value>,
    pub(super) published_views: Vec<PublishedExtensionView>,
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

    pub(super) async fn invoke(
        &mut self,
        package: &ExtensionPackage,
        action_id: &str,
        target: Option<&ExtensionViewScope>,
        input: &Value,
        storage: &BTreeMap<String, Value>,
        thread_summaries: Option<&[ExtensionThreadSummary]>,
    ) -> Result<ExtensionHostActionResult, DaemonError> {
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
        self.ensure_started().await?;
        let request_id = self.next_request_id;
        self.next_request_id = if request_id >= MAX_SAFE_JAVASCRIPT_INTEGER {
            1
        } else {
            request_id + 1
        };
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
        };
        let response = self
            .send_request(&request, request_id, HOST_ACTION_TIMEOUT, "action")
            .await?;
        Ok(ExtensionHostActionResult {
            result: response.result,
            storage: response.storage,
            published_views: response.published_views,
        })
    }

    pub(super) async fn dispatch_event(
        &mut self,
        package: &ExtensionPackage,
        event: &ExtensionEvent,
        storage: &BTreeMap<String, Value>,
        thread_summaries: Option<&[ExtensionThreadSummary]>,
    ) -> Result<ExtensionHostActionResult, DaemonError> {
        if serde_json::to_vec(event)?.len() > MAX_EXTENSION_EVENT_BYTES {
            return Err(DaemonError::BadRequest(format!(
                "extension event exceeds {MAX_EXTENSION_EVENT_BYTES} bytes"
            )));
        }
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
        self.ensure_started().await?;
        let request_id = self.next_request_id;
        self.next_request_id = if request_id >= MAX_SAFE_JAVASCRIPT_INTEGER {
            1
        } else {
            request_id + 1
        };
        let request = HostEventRequest {
            request_id,
            method: "event.dispatch",
            extension_id: &package.id,
            entrypoint: package.entrypoint.to_string_lossy().into_owned(),
            event,
            storage,
            thread_summaries,
        };
        let response = self
            .send_request(&request, request_id, HOST_EVENT_TIMEOUT, "event")
            .await?;
        Ok(ExtensionHostActionResult {
            result: response.result,
            storage: response.storage,
            published_views: response.published_views,
        })
    }

    async fn send_request(
        &mut self,
        request: &impl Serialize,
        request_id: u64,
        request_timeout: Duration,
        operation: &str,
    ) -> Result<HostActionResponse, DaemonError> {
        let line = serde_json::to_vec(request)?;
        let process = self
            .process
            .as_mut()
            .ok_or_else(|| DaemonError::Process("extension host unavailable".to_string()))?;
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
                return Err(error);
            }
            Err(_) => {
                self.stop().await;
                return Err(DaemonError::Process(format!(
                    "extension {operation} timed out"
                )));
            }
        };
        if response.request_id != request_id {
            self.stop().await;
            return Err(DaemonError::Process(
                "extension host returned a mismatched request id".to_string(),
            ));
        }
        if !response.ok {
            return Err(DaemonError::Process(
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
    use falcondeck_core::{InvokeExtensionActionRequest, ThreadStatus};

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
            status: ThreadStatus::WaitingForInput,
            updated_at: chrono::Utc::now(),
            pending_approval_count: 1,
            pending_question_count: 0,
        }];
        let denied = match host
            .dispatch_event(&package, &event, &BTreeMap::new(), None)
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
            .dispatch_event(&package, &event, &BTreeMap::new(), Some(&summaries))
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
            .invoke(&package, "run", None, &Value::Null, &BTreeMap::new(), None)
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

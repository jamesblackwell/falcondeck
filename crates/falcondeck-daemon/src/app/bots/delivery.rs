//! Hash-only receipts for change-triggered Claude bot configuration delivery.
use super::context::AgentContextPlan;
use super::*;

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub(in crate::app) struct ClaudeBotContextReceipt {
    native_session_id: String,
    standing_hash: String,
    files: BTreeMap<String, String>,
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn render_update(updates: Vec<String>) -> Option<String> {
    (!updates.is_empty()).then(|| format!(
        "<falcondeck_bot_context_update>\nFalconDeck configuration update: these are the current editable bot instructions and context files. They supersede their earlier versions; unchanged parts remain in effect.\n\n{}\n</falcondeck_bot_context_update>", updates.join("\n\n")
    ))
}

impl AppState {
    fn bot_context_receipt_path(&self, thread_id: &str) -> PathBuf {
        self.inner
            .state_path
            .parent()
            .unwrap_or(Path::new("."))
            .join("bot-context-delivery")
            .join(format!("{}.json", digest(thread_id.as_bytes())))
    }

    pub(in crate::app) async fn prepare_claude_bot_context_delivery(
        &self,
        thread_id: &str,
        plan: &mut AgentContextPlan,
    ) {
        let Some(bot) = plan.bot.as_ref() else {
            return;
        };
        let native_id = self
            .inner
            .workspaces
            .lock()
            .await
            .values()
            .find_map(|ws| ws.threads.get(thread_id))
            .and_then(|thread| thread.summary.native_session_id.clone());
        let previous: Option<ClaudeBotContextReceipt> =
            tokio::fs::read(self.bot_context_receipt_path(thread_id))
                .await
                .ok()
                .and_then(|bytes| serde_json::from_slice(&bytes).ok())
                .filter(|receipt: &ClaudeBotContextReceipt| {
                    Some(&receipt.native_session_id) == native_id.as_ref()
                });
        let instructions = plan.instructions.as_deref().unwrap_or_default();
        let standing_hash = digest(instructions.as_bytes());
        let mut updates = Vec::new();
        // A first native session sees the append. An unknown/resumed one may
        // ignore it, so bridge the current standing configuration through input.
        if native_id.is_some()
            && previous
                .as_ref()
                .is_none_or(|old| old.standing_hash != standing_hash)
        {
            updates.push(format!("## Current standing instructions\n{instructions}"));
        }
        let mut paths = bot.context_files.clone();
        paths.sort();
        paths.dedup();
        let reads = tokio::task::spawn_blocking(move || {
            paths
                .into_iter()
                .map(|path| {
                    let text = super::context::read_injected(Path::new(&path))
                        .unwrap_or_else(|error| format!("(Unavailable: {error})"));
                    let mut fingerprint = text.clone();
                    // Reads stay bounded; tail edits of a truncated file still trigger
                    // a notice directing the model to read the rest from disk.
                    if let Ok(meta) = std::fs::metadata(&path)
                        && meta.len() > super::context::MAX_INJECTED_BYTES as u64
                    {
                        fingerprint.push_str(&format!(
                            "\n{}:{:?}",
                            meta.len(),
                            meta.modified().ok()
                        ));
                    }
                    (path, digest(fingerprint.as_bytes()), text)
                })
                .collect::<Vec<_>>()
        })
        .await;
        let Ok(reads) = reads else {
            // Never acknowledge file contents that could not be captured.
            updates.push("Read the attached context file paths before relying on earlier copies; their current contents could not be captured.".into());
            plan.context_update = render_update(updates);
            return;
        };
        let mut files = BTreeMap::new();
        for (path, hash, text) in reads {
            if previous.as_ref().and_then(|old| old.files.get(&path)) != Some(&hash) {
                updates.push(format!("## Current context file: {path}\n{text}"));
            }
            files.insert(path, hash);
        }
        if let Some(old) = &previous {
            for path in old.files.keys().filter(|path| !files.contains_key(*path)) {
                updates.push(format!(
                    "Context file detached: {path}. It is no longer standing context."
                ));
            }
        }
        plan.context_update = render_update(updates);
        let receipt = ClaudeBotContextReceipt {
            native_session_id: native_id.unwrap_or_default(),
            standing_hash,
            files,
        };
        if previous.as_ref() != Some(&receipt) {
            plan.delivery_receipt = Some(receipt);
        }
    }

    pub(in crate::app) async fn invalidate_claude_bot_context_delivery(&self, thread_id: &str) {
        if let Err(error) = tokio::fs::remove_file(self.bot_context_receipt_path(thread_id)).await
            && error.kind() != std::io::ErrorKind::NotFound
        {
            tracing::warn!(%thread_id, %error, "could not invalidate bot context delivery receipt");
        }
    }

    pub(in crate::app) async fn finish_claude_bot_context_delivery(
        &self,
        workspace_id: &str,
        thread_id: &str,
        success: bool,
    ) {
        let receipt = {
            let mut workspaces = self.inner.workspaces.lock().await;
            let Some(thread) = workspaces
                .get_mut(workspace_id)
                .and_then(|ws| ws.threads.get_mut(thread_id))
            else {
                return;
            };
            thread
                .pending_bot_context_delivery
                .take()
                .and_then(|mut receipt| {
                    if !success {
                        return None;
                    }
                    receipt.native_session_id = thread.summary.native_session_id.clone()?;
                    Some(receipt)
                })
        };
        let Some(receipt) = receipt else {
            return;
        };
        let path = self.bot_context_receipt_path(thread_id);
        let result = match serde_json::to_vec(&receipt) {
            Ok(bytes) => crate::app::storage::write_atomically(&path, bytes).await,
            Err(error) => Err(DaemonError::from(error)),
        };
        if let Err(error) = result {
            tracing::warn!(%thread_id, %error, "could not save bot context delivery receipt; updates will be retried");
        }
    }
}

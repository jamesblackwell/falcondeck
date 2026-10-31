//! Bounded continuity evidence. Never claims excerpts are a complete semantic summary.
use super::*;
use falcondeck_core::ThreadDetailMode;

pub(super) const BRIEFING_BYTES: usize = 64_000;

fn bounded(text: &str, budget: usize) -> String {
    if text.len() <= budget {
        return text.into();
    }
    let suffix = "\n[section truncated]\n";
    let suffix = if budget >= suffix.len() { suffix } else { "" };
    let mut end = budget.saturating_sub(suffix.len()).min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{suffix}", &text[..end])
}

impl AppState {
    pub(crate) async fn continuity_briefing(
        &self,
        workspace: &str,
        thread: &str,
    ) -> Result<String, DaemonError> {
        let summary = self.thread_summary(workspace, thread).await?;
        // Switching again before the first send must not discard the deferred
        // source transcript just because the intermediate home is empty.
        if let Some(pending) = self
            .inner
            .workspaces
            .lock()
            .await
            .get(workspace)
            .and_then(|ws| ws.threads.get(thread))
            .filter(|managed| managed.items.is_empty())
            .and_then(|managed| managed.pending_handoff_context.clone())
        {
            return Ok(bounded(&pending, BRIEFING_BYTES));
        }
        let workspace_path = self
            .inner
            .workspaces
            .lock()
            .await
            .get(workspace)
            .ok_or_else(|| DaemonError::NotFound("workspace not found".into()))?
            .summary
            .path
            .clone();
        let bot = self.bot_for_thread(thread).await;
        let mut text = format!(
            "# Continuity briefing\nSource: {thread} ({})\nTitle: {}\nWorkspace: {workspace_path}\n\n## Standing state\n",
            summary.provider, summary.title
        );
        if let Some(bot) = &bot {
            text.push_str(&format!("Bot: {} ({})\nRead {}/STATUS.md, TODO.md and MEMORY.md when present, then relevant supporting documents. Standing instructions, context files, document inventory, peer status paths and FalconDeck tools are injected fresh on every turn. Do not treat this briefing as newer than those files.\n", bot.name, bot.id, bot.space_path));
        }
        text.push_str("\n## Delegated tasks\n");
        let tasks = self.inner.workspaces.lock().await.values().flat_map(|ws| ws.threads.values())
            .filter(|t| !t.summary.is_archived && matches!(&t.summary.origin, Some(falcondeck_core::ThreadOrigin::AgentSpawn { parent_thread_id, .. }) if parent_thread_id == thread || bot.as_ref().is_some_and(|b| b.owns_thread(parent_thread_id))))
            .map(|t| format!("- {} [{}] {:?}: {}\n", t.summary.title, t.summary.id, t.summary.status, t.summary.last_message_preview.as_deref().unwrap_or("")))
            .collect::<Vec<_>>().join("");
        text.push_str(&bounded(&tasks, 8_000));
        // strict_limit is essential: ordinary Tail may widen to a distant user prompt.
        let recent = self
            .thread_detail_with_request(&ThreadDetailRequest {
                workspace_id: workspace.into(),
                thread_id: thread.into(),
                mode: ThreadDetailMode::Tail,
                limit: Some(40),
                strict_limit: Some(true),
                inline_images: Some(false),
                tool_output_bytes: Some(1000),
                compact_workspace: Some(true),
                before_item_id: None,
                refresh_native: None,
            })
            .await?;
        let start = recent
            .oldest_item_id
            .as_deref()
            .and_then(|id| {
                recent
                    .items
                    .iter()
                    .position(|i| workspace_ops::conversation_item_id(i) == id)
            })
            .unwrap_or(0);
        let recent_items = &recent.items[start..];
        let recent_prompt = recent.items[..start]
            .iter()
            .find_map(|item| {
                if let ConversationItem::UserMessage { text, .. } = item {
                    Some(format!(
                        "### Latest user request (outside the contiguous tail)\n{}\n",
                        bounded(text, 4_000)
                    ))
                } else {
                    None
                }
            })
            .unwrap_or_default();
        let mut recent_sections = Vec::new();
        let mut used = recent_prompt.len();
        let mut oldest_retained = None;
        for item in recent_items.iter().rev() {
            let (heading, body) = super::super::thread_tools::read::item_parts(item, false);
            let section = format!("### {heading}\n{body}\n");
            if used + section.len() > 28_000 {
                if recent_sections.is_empty() {
                    recent_sections.push(bounded(&section, 28_000 - used));
                }
                break;
            }
            oldest_retained = Some(workspace_ops::conversation_item_id(item).to_string());
            used += section.len();
            recent_sections.push(section);
        }
        let before = oldest_retained.or_else(|| {
            recent_items
                .first()
                .map(|i| workspace_ops::conversation_item_id(i).to_string())
        });
        text.push_str("\n## Older history: commitments, decisions and pending asks (evidence excerpts)\nThese are deterministic excerpts, not an exhaustive summary. Verify open promises and decision reasons against STATUS.md and the source transcript; omitted history is still available there.\n");
        if recent.has_older || recent_sections.len() < recent_items.len() {
            text.push_str(
                &self
                    .older_continuity_evidence(workspace, thread, before)
                    .await?,
            );
        }
        text.push_str("\n## Harness-native memory\n");
        let memory = native_memory(&summary.provider, &workspace_path);
        text.push_str(&memory);
        text.push_str("\n## Recent conversation (complete items within 28 KB; older or oversized items omitted)\n");
        recent_sections.reverse();
        text.push_str(&recent_prompt);
        text.push_str(&recent_sections.concat());
        text.push_str(&format!("\nRecovery: source thread `{thread}` retains the full native history. Use falcondeck_view_thread with before/item_id to recover omitted details.\n"));
        Ok(bounded(&text, BRIEFING_BYTES))
    }
    async fn older_continuity_evidence(
        &self,
        workspace: &str,
        thread: &str,
        mut before: Option<String>,
    ) -> Result<String, DaemonError> {
        let categories: [(&str, &[&str]); 3] = [
            (
                "Commitments and promises",
                &["will ", "promise", "follow up", "commit", "tomorrow"],
            ),
            (
                "Decisions and reasons",
                &["decid", "because", "chose", "agreed", "reason", "instead"],
            ),
            (
                "Pending asks to/from James and peers",
                &[
                    "james", "waiting", "pending", "ask", "need", "blocked", "?", "juno", "iris",
                    "atlas", "libra", "moneta", "vulcan",
                ],
            ),
        ];
        let mut evidence = vec![String::new(); categories.len()];
        let mut scanned = 0;
        let mut older = true;
        for _ in 0..12 {
            let Some(cursor) = before.clone() else {
                break;
            };
            let page = self
                .thread_detail_with_request(&ThreadDetailRequest {
                    workspace_id: workspace.into(),
                    thread_id: thread.into(),
                    mode: ThreadDetailMode::Before,
                    before_item_id: Some(cursor.clone()),
                    limit: Some(100),
                    inline_images: Some(false),
                    tool_output_bytes: Some(0),
                    strict_limit: Some(true),
                    compact_workspace: Some(true),
                    refresh_native: None,
                })
                .await?;
            older = page.has_older;
            scanned += page.items.len();
            for item in page.items.iter().rev() {
                if !matches!(
                    item,
                    ConversationItem::UserMessage { .. }
                        | ConversationItem::AssistantMessage { .. }
                        | ConversationItem::Plan { .. }
                ) {
                    continue;
                }
                let (role, body) = super::super::thread_tools::read::item_parts(item, false);
                let lower = body.to_lowercase();
                for (index, (_, terms)) in categories.iter().enumerate() {
                    if evidence[index].len() < 4_500
                        && terms.iter().any(|term| lower.contains(term))
                    {
                        // Keep the matched line and neighbours rather than losing the
                        // decision reason in a long message's opening paragraph.
                        let lines = body.lines().collect::<Vec<_>>();
                        if let Some(at) = lines.iter().position(|line| {
                            terms.iter().any(|term| line.to_lowercase().contains(term))
                        }) {
                            let quote =
                                lines[at.saturating_sub(1)..(at + 3).min(lines.len())].join("\n");
                            let remaining = 700.min(4_500 - evidence[index].len());
                            evidence[index].push_str(&bounded(
                                &format!(
                                    "- {role} [{}]: {}\n",
                                    workspace_ops::conversation_item_id(item),
                                    quote
                                ),
                                remaining,
                            ));
                        }
                    }
                }
            }
            before = page.oldest_item_id;
            if !older || before.as_deref() == Some(&cursor) {
                break;
            }
        }
        let mut result = format!(
            "Scanned {scanned} older items (maximum 1,200); additional older history: {older}. Excerpts are newest-first, may include already-resolved asks, and are capped per category.\n"
        );
        for ((title, _), quotes) in categories.iter().zip(evidence) {
            result.push_str(&format!(
                "### {title}\n{}\n",
                if quotes.is_empty() {
                    "No matching evidence in the scanned window."
                } else {
                    &quotes
                }
            ));
        }
        Ok(result)
    }
}

fn native_memory(provider: &AgentProvider, workspace: &str) -> String {
    let Some(home) = std::env::var_os("HOME") else {
        return "Memory location unavailable.\n".into();
    };
    let root = if provider == &AgentProvider::CLAUDE {
        let mangled: String = workspace
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || c == '-' {
                    c
                } else {
                    '-'
                }
            })
            .collect();
        PathBuf::from(home)
            .join(".claude/projects")
            .join(mangled)
            .join("memory")
    } else if provider == &AgentProvider::CODEX {
        std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from(home).join(".codex"))
            .join("memories")
    } else {
        return "No workspace-scoped memory exporter for this harness. Read durable memory in the bot document space; native global memories are not copied into other conversations.\n".into();
    };
    let mut result = format!("Source: {}\n", root.display());
    let mut paths = std::fs::read_dir(&root)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|e| e.path())
        .collect::<Vec<_>>();
    paths.sort_by_key(|path| {
        (
            path.file_name()
                .is_none_or(|name| name != "MEMORY.md" && name != "memory_summary.md"),
            path.clone(),
        )
    });
    if provider == &AgentProvider::CODEX {
        paths.retain(|path| {
            path.file_name()
                .is_some_and(|name| name == "memory_summary.md" || name == "MEMORY.md")
        });
        result.push_str(
            "Codex shared memory index (may include other projects; verify relevance).\n",
        );
    }
    for path in paths.into_iter().take(40) {
        if result.len() >= 8_000 {
            break;
        }
        if let Ok(mut file) = open_document(&path, false, false) {
            let mut content = Vec::new();
            if Read::by_ref(&mut file)
                .take(8_001)
                .read_to_end(&mut content)
                .is_ok()
            {
                let per_file = if provider == &AgentProvider::CODEX {
                    3_800
                } else {
                    8_000
                };
                result.push_str(&format!(
                    "### {}\n{}\n",
                    path.file_name().unwrap_or_default().to_string_lossy(),
                    bounded(
                        &String::from_utf8_lossy(&content),
                        per_file.min(8_000 - result.len())
                    )
                ));
            }
        }
    }
    bounded(&result, 8_000)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn byte_budget_handles_unicode_and_tiny_sections() {
        for budget in 0..100 {
            assert!(bounded(&"🦅".repeat(100), budget).len() <= budget);
        }
    }
}

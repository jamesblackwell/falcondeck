//! Live tracking of native harness sub-agents (Claude's `Agent` tool) so
//! clients can show which sub-agents a thread is running without scrolling
//! to their tool cards. The tracker is owned by one Claude monitor loop and
//! published on [`falcondeck_core::ThreadAttention::active_subagents`].

use std::collections::{BTreeMap, HashSet};

use chrono::{DateTime, Utc};
use falcondeck_core::ActiveSubagent;
use serde_json::Value;

/// Spawn tool names: current CLIs call it `Agent`, older ones `Task`.
pub(super) fn is_subagent_tool(tool_kind: &str) -> bool {
    matches!(tool_kind, "Agent" | "Task")
}

#[derive(Default)]
pub(super) struct SubagentTracker {
    /// Keyed by spawning tool call id.
    entries: BTreeMap<String, Entry>,
    /// Background task id -> spawning tool call id.
    tasks: BTreeMap<String, String>,
    dirty: bool,
}

struct Entry {
    label: String,
    agent_type: Option<String>,
    started_at: DateTime<Utc>,
    background: bool,
}

impl SubagentTracker {
    /// A main-loop tool event. `input` is only present on the call itself.
    pub(super) fn tool_event(
        &mut self,
        id: &str,
        tool_kind: &str,
        title: &str,
        status: &str,
        input: Option<&Value>,
    ) {
        if !is_subagent_tool(tool_kind) {
            return;
        }
        if status == "running" {
            let text = |key: &str| {
                input
                    .and_then(|v| v.get(key))
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|v| !v.is_empty())
                    .map(str::to_string)
            };
            let background = input
                .and_then(|v| v.get("run_in_background"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let label = text("description").unwrap_or_else(|| title.to_string());
            let agent_type = text("subagent_type");
            match self.entries.get_mut(id) {
                None => {
                    self.entries.insert(id.to_string(), Entry {
                        label,
                        agent_type,
                        started_at: Utc::now(),
                        background,
                    });
                    self.dirty = true;
                }
                // Streaming repeats the call, sometimes without input; only
                // a repeat that adds information is a change.
                Some(entry) if input.is_some() => {
                    let changed = entry.label != label
                        || entry.agent_type != agent_type
                        || (background && !entry.background);
                    if changed {
                        entry.label = label;
                        entry.agent_type = agent_type;
                        entry.background |= background;
                        self.dirty = true;
                    }
                }
                Some(_) => {}
            }
            return;
        }
        // Every agent gets a task, and a foreground agent's task reports
        // before its tool result. A task still live when the tool call
        // settles therefore belongs to a background agent: the result was
        // only a launch receipt, and the agent runs until it reports.
        // Failures end it either way.
        let task_live = self.tasks.values().any(|tool_id| tool_id == id);
        if status == "completed"
            && let Some(entry) = self.entries.get_mut(id)
            && (entry.background || task_live)
        {
            if !entry.background {
                entry.background = true;
                self.dirty = true;
            }
            return;
        }
        self.remove(id);
    }

    /// `task_started` for an agent, foreground or background. Claude emits
    /// one for every `Agent` call; the task id is what reports completion.
    pub(super) fn agent_task_started(&mut self, task_id: &str, tool_use_id: &str) {
        if self.entries.contains_key(tool_use_id) {
            self.tasks.insert(task_id.to_string(), tool_use_id.to_string());
        }
    }

    pub(super) fn task_finished(&mut self, task_id: &str, tool_use_id: Option<&str>) {
        let id = tool_use_id
            .map(str::to_string)
            .or_else(|| self.tasks.get(task_id).cloned());
        self.tasks.remove(task_id);
        if let Some(id) = id {
            self.remove(&id);
        }
    }

    /// `background_tasks_changed` lists every live task, so a known agent
    /// task missing from it has ended even if its notification was lost.
    pub(super) fn retain_tasks(&mut self, live: &HashSet<String>) {
        let gone: Vec<(String, String)> = self
            .tasks
            .iter()
            .filter(|(task_id, _)| !live.contains(*task_id))
            .map(|(t, id)| (t.clone(), id.clone()))
            .collect();
        for (task_id, id) in gone {
            self.tasks.remove(&task_id);
            self.remove(&id);
        }
    }

    /// The turn parked: its tool cards are settled, so any foreground agent
    /// still listed is over. Background agents outlive the park.
    pub(super) fn clear_foreground(&mut self) {
        let before = self.entries.len();
        self.entries.retain(|_, entry| entry.background);
        self.dirty |= self.entries.len() != before;
    }

    fn remove(&mut self, id: &str) {
        if self.entries.remove(id).is_some() {
            self.dirty = true;
        }
        self.tasks.retain(|_, tool_id| tool_id != id);
    }

    /// The current list when it changed since the last call.
    pub(super) fn take_changed(&mut self) -> Option<Vec<ActiveSubagent>> {
        if !std::mem::take(&mut self.dirty) {
            return None;
        }
        let mut list: Vec<ActiveSubagent> = self
            .entries
            .iter()
            .map(|(id, entry)| ActiveSubagent {
                id: id.clone(),
                label: entry.label.clone(),
                agent_type: entry.agent_type.clone(),
                started_at: entry.started_at,
                background: entry.background,
            })
            .collect();
        list.sort_by(|a, b| a.started_at.cmp(&b.started_at).then_with(|| a.id.cmp(&b.id)));
        Some(list)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    /// Event order probed from the Claude CLI (Nov 2026): tool_use,
    /// task_started, task_notification, then the tool result.
    fn foreground_agent_ends_at_its_task_notification() {
        let mut t = SubagentTracker::default();
        t.tool_event("a", "Agent", "Agent", "running", Some(&json!({
            "description": "Find relay retries", "subagent_type": "Explore",
            "run_in_background": false
        })));
        t.agent_task_started("task-1", "a");
        let list = t.take_changed().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].label, "Find relay retries");
        assert_eq!(list[0].agent_type.as_deref(), Some("Explore"));
        assert!(!list[0].background);
        t.tool_event("a", "Agent", "Agent", "running", None);
        assert!(t.take_changed().is_none());
        t.task_finished("task-1", Some("a"));
        assert_eq!(t.take_changed().unwrap(), vec![]);
        t.tool_event("a", "Agent", "Agent", "completed", None);
        assert!(t.take_changed().is_none());
    }

    #[test]
    fn foreground_agent_without_a_task_ends_at_its_tool_result() {
        let mut t = SubagentTracker::default();
        t.tool_event("a", "Task", "Old CLI", "running", Some(&json!({})));
        t.take_changed();
        t.tool_event("a", "Task", "Old CLI", "completed", None);
        assert_eq!(t.take_changed().unwrap(), vec![]);
    }

    #[test]
    fn agent_with_a_live_task_after_its_result_is_background() {
        let mut t = SubagentTracker::default();
        t.tool_event("a", "Agent", "Agent", "running", Some(&json!({"description": "Audit"})));
        t.agent_task_started("task-1", "a");
        t.take_changed();
        t.tool_event("a", "Agent", "Agent", "completed", None);
        let list = t.take_changed().unwrap();
        assert!(list[0].background);
        t.task_finished("task-1", None);
        assert_eq!(t.take_changed().unwrap(), vec![]);
    }

    #[test]
    fn background_agent_outlives_its_launch_receipt() {
        let mut t = SubagentTracker::default();
        t.tool_event("a", "Agent", "Agent", "running", Some(&json!({
            "description": "Audit", "run_in_background": true
        })));
        t.agent_task_started("task-1", "a");
        t.tool_event("a", "Agent", "Agent", "completed", None);
        let list = t.take_changed().unwrap();
        assert_eq!(list.len(), 1);
        assert!(list[0].background);
        t.clear_foreground();
        assert!(t.take_changed().is_none());
        t.task_finished("task-1", None);
        assert_eq!(t.take_changed().unwrap(), vec![]);
    }

    #[test]
    fn background_list_drops_agents_that_vanished() {
        let mut t = SubagentTracker::default();
        t.tool_event("a", "Agent", "x", "running", Some(&json!({"run_in_background": true})));
        t.agent_task_started("task-1", "a");
        t.take_changed();
        t.retain_tasks(&HashSet::new());
        assert_eq!(t.take_changed().unwrap(), vec![]);
    }

    #[test]
    fn failed_background_launch_is_removed_and_other_tools_ignored() {
        let mut t = SubagentTracker::default();
        t.tool_event("b", "Bash", "ls", "running", None);
        assert!(t.take_changed().is_none());
        t.tool_event("a", "Task", "Old", "running", Some(&json!({"run_in_background": true})));
        t.tool_event("a", "Task", "Old", "failed", None);
        assert_eq!(t.take_changed().unwrap(), vec![]);
    }
}

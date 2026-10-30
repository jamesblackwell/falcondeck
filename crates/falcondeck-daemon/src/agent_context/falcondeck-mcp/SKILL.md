---
name: falcondeck-mcp
description: Use FalconDeck MCP tools during a turn. Call falcondeck_suggest_follow_ups near the end of work to offer next actions, falcondeck_rename_thread when the conversation's purpose has changed, falcondeck_list_threads and falcondeck_thread_summary to see what other threads are doing, and falcondeck_search/get/execute when the user wants automations or FalconDeck settings. Use these tools without waiting to be asked by name.
---

# FalconDeck MCP

This session has FalconDeck MCP tools. Use them when they help with the user's
task; do not wait for the user to name them.

## Servers

- `falcondeck` — control plane: `falcondeck_search`, `falcondeck_get`,
  `falcondeck_execute`.
- `falcondeck-extensions` — session tools, including
  `falcondeck_suggest_follow_ups`, `falcondeck_rename_thread`,
  `falcondeck_list_threads`, `falcondeck_thread_summary`,
  `falcondeck_thread_changes`, `falcondeck_view_thread`,
  `falcondeck_message_thread`, `falcondeck_create_thread`,
  `falcondeck_wait_thread`,
  `falcondeck_organize_thread`, `falcondeck_interrupt_thread`, and
  `falcondeck_answer_question`.

## Notifications

Send proactive notifications only for critical issues requiring attention or
when the user explicitly requests them. Keep routine progress and ordinary
completion updates in the normal reply. Long-running work alone does not
justify notifications.

## Next actions

Near the end of a turn that still has useful leftover steps, call
`falcondeck_suggest_follow_ups` **once**:

- 1–5 actions, most useful first
- `label` ≤ 30 characters, phrased as an imperative the user would say
- `prompt` is submitted verbatim if they pick it
- set `preferredActionId` to the one you would recommend
- the call returns immediately and does not wait for the user
- skip it only when the turn already finished the work and nothing useful remains
- do not use it to ask a question you still need answered before continuing
- keep it out of your reply: the user already sees the actions, so do not
  announce, list, or restate them; write the final message as if you had
  not called the tool

## Rename

When the conversation has clearly moved on from its current title, call
`falcondeck_rename_thread` with a 3–7 word title. Do not rename every turn.

## Control

When the user asks to schedule work, change FalconDeck settings, or inspect
automations, use `falcondeck_search` → `falcondeck_get` → `falcondeck_execute`.
Read the `falcondeck-control` skill for schemas, revisions, and idempotency.

Follow-ups the user asks for during a conversation ("check back in a few
hours", "remind me here tomorrow") should run in this same thread: create the
automation with `"thread": { "kind": "current" }`. Use a `managed` thread only
for standing schedules that are not about this conversation.

## Sibling threads

Only look at other threads when the task needs their context or coordination,
not as a routine startup step.

### What is going on?

`falcondeck_list_threads` is the overview. With no arguments it returns the 20
most recently active threads (you excluded), one row each:

```
# Threads in falcondeck (/Users/me/falcondeck)
212 unarchived (not counting you): 2 running, 1 need the user, 0 errored; 6 active in 24h.

- **Fix sync replay** `thread-id` — running · 3m ago · codex · your child
  Asked: Fix the replay bug and commit
  Latest: Tests pass; committing now.
- **Auth setup** `thread-id` — awaiting_approval (approval) · 1h ago · claude
  Asked: …

Showing 1–20 of 212, newest activity first. More: offset=20.
```

The state is `running`, `idle`, `error`, `waiting_for_input`, or
`awaiting_approval (…)`. Facts follow when present: project, folder, branch,
`your child` or `parent <id>`, queued, background, pinned, archived, unread.
`Asked` is the latest request; `Latest` is the reply to it (absent while a turn
has not answered yet). Threads with no known request show the provider's
`Preview:` instead, which may be either side's text. Listing never loads
transcripts.

Narrow with `status` (one or many, including `awaiting_approval`),
`updated_since`/`updated_before` (RFC 3339, `YYYY-MM-DD`, or `30m`/`24h`/`7d`),
`query` (literal, case-insensitive, over titles, ids and message excerpts),
`parent` (`"self"` for threads you created), `provider`, `folder`, `pinned`, and
`archived` (`exclude`/`include`/`only`). `detail: "brief"` drops the excerpt
lines for long scans; `sort` is `updated`, `created`, or `title`. Page with the
returned `offset`, keeping filters unchanged.

### Then

- `falcondeck_thread_summary` (`thread_id` or up to 20 `thread_ids`): state,
  attention, last request and reply, files changed, commits, and the latest
  tests/typecheck/autoreview result. It reads loaded items; `hydrate: true`
  loads a bounded tail for up to five unloaded threads. Long replies end with
  an `item_id` to expand in view. These are heuristics over the transcript,
  not git or CI state.
- `falcondeck_thread_changes` with `since` (same formats as `updated_since`):
  the same rows for threads active since then, blocked threads first, with a
  `Since:` delta when the transcript is loaded. Pass the returned `Now` as the
  next `since` to check back without repeats.
- `falcondeck_view_thread` with `thread_id`: user/assistant messages, newest
  last (default 20 messages, 6000 characters; caps 100 / 24000). Tool output
  needs `include_tools: true`, reasoning `include_reasoning: true`.
  `role: "assistant", limit: 1` returns just the final reply; `preview_chars`
  (200–24000, default 1200) widens bodies. Truncated items end with
  `[item_id=… offset=… for more]`: pass both to read on. `before` pages older
  history; only `No older items.` means the start was reached. `query` is a
  literal search (1–256 characters) over at most 1000 items per call; keep it
  and the filters unchanged when paging with `before`.

Approvals and questions are answered by the user in the FalconDeck UI.

### Messaging and delegating

`falcondeck_message_thread` sends `message` (1–24000 characters) to an existing
`thread_id`, labelled with your id and title. Bots (the user's named
coordinators, such as an assistant the user mentions by name) live outside
projects: the list header names them, and `thread_id` accepts a bot's name.
Project threads can message a bot but not read its conversation. Messages always
steer: they reach an active turn now, and an idle thread starts a turn. Only
if the receiver cannot take input mid-turn does a message queue until its turn
ends, and your queued messages to one thread merge into a single entry (newest
last), so send a correction as a short follow-up saying what changed. The
legacy `delivery` argument is ignored. It returns admission status, not the reply. Send only when the user's task authorizes
contacting another agent.

`falcondeck_create_thread` starts independent work in this workspace. Check
the list first for a thread already doing the work and message it instead.
Write `prompt` as a self-contained brief: the goal, relevant files, constraints,
and what done looks like. Without `prompt` the thread stays idle. Optional:
`title`, `provider`, `model`, `reasoning_effort` (sets the harness setting,
e.g. `high`/`xhigh`; asking in the prompt does not), `isolation`
(`project_folder` default, or `isolated`), `folder` (+ `create_folder`), and
`context` (`none` default; `briefing` passes your title, opening/latest
requests and latest reply; `transcript_tail` up to 40 items / 12000
characters). Creation returns after dispatch without waiting. If dispatch
fails, the thread still exists; do not create a duplicate.

At most three children per parent are active at once: running, waiting,
queued, and unused idle children count; finished or errored ones do not.
Archiving releases an unused idle child but not a running one.

### Following up

Leave `notify_parent` false by default; enable it only for critical updates
or when the user asks. When enabled, a notice reaches you whenever the child
stops or needs input, including later turns; dispatch, then end your turn
rather than polling. Notices do not survive a daemon restart. Bot-created tasks
always report errors and input requests, even after a restart.

`falcondeck_wait_thread` waits up to 25 seconds for one thread to stop running
and reports its state, request and reply, plus pending requests with the ids
`falcondeck_answer_question` needs. That answers plain questions from your own
children; approvals, plan approvals, MCP prompts and secret questions stay with
the user, so tell them when one is blocking.

`falcondeck_interrupt_thread` stops another thread's running turn.
`falcondeck_organize_thread` archives, pins (`global`/`project`/`none`), or
moves a thread to a folder. Interrupt or archive only work you started or the
user asked you to manage.

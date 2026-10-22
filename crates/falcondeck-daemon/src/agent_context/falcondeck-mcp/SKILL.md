---
name: falcondeck-mcp
description: Use FalconDeck MCP tools during a turn. Call falcondeck_suggest_follow_ups near the end of work to offer next actions, falcondeck_rename_thread when the conversation's purpose has changed, and falcondeck_search/get/execute when the user wants automations or FalconDeck settings. Use these tools without waiting to be asked by name.
---

# FalconDeck MCP

This session has FalconDeck MCP tools. Use them when they help with the user's
task; do not wait for the user to name them.

## Servers

- `falcondeck` — control plane: `falcondeck_search`, `falcondeck_get`,
  `falcondeck_execute`.
- `falcondeck-extensions` — session tools, including
  `falcondeck_suggest_follow_ups`, `falcondeck_rename_thread`,
  `falcondeck_list_threads`, `falcondeck_view_thread`, `falcondeck_message_thread`,
  `falcondeck_create_thread`, `falcondeck_wait_thread`,
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

Only inspect sibling threads when the task needs context or coordination from
other threads. Do not list threads as a routine startup step or repeatedly check
them during unrelated work.

Use `falcondeck_list_threads` to find work in this workspace. Results are bounded
markdown summaries with last activity, folder, attention, a labelled preview, and
cached opening/recent user excerpts; listing does not load transcripts. Defaults:
unarchived threads, newest activity first, `limit` 30 (max 100), `max_chars`
24000 (512–24000). Page with the returned `offset`, keeping sort and filters
unchanged. `sort`: `updated`, `created`, or `title`, plus `order`. Filters:
`status` (string or array: idle, running, waiting_for_input, error,
awaiting_approval), `provider`, `folder`, `archived` (exclude/include/only),
`pinned`, `has_pending_approval`, `updated_since`/`updated_before` (RFC 3339,
`YYYY-MM-DD`, or `30m`/`24h`/`7d`), and `query` (case-insensitive literal).

Use `falcondeck_view_thread` with `thread_id` for compact user/assistant text.
Start with defaults: 20 messages / 6000 characters. Hard caps are 100 messages
and 24000 characters (`max_chars` range 512–24000). Tool output and other
activity are omitted unless `include_tools: true`; reasoning independently
requires `include_reasoning: true`. Prefer targeted reads to loading whole threads.

Pass the returned `before` cursor for older history. A call scans at most 1000
underlying items; an empty filtered page can still have an older cursor. Only
`No older items` means the beginning of available history was reached.

Use `query` for case-insensitive literal search (1–256 characters, no regex).
Matches include short excerpts and item ids; search examines original bodies,
not just previews. Keep query and filters unchanged when paging. To expand a
specific result, pass its `item_id` without query/before. Follow `next_offset`
with `offset` (characters in the item body) to read more. This explicit selection
includes the item's kind regardless of filters. Images and diff bodies are omitted.

Items carry their timestamp beside the id, and each read starts with the
thread's status and an `ATTENTION:` line when it waits on an approval, a user
question, or has errored. `role: "assistant"` with `limit: 1` returns just the
final assistant message; raise `preview_chars` (200–24000, default 1200) to read
it whole.

To oversee several threads, prefer `falcondeck_thread_summary` (`thread_id` or
up to 20 `thread_ids`): status, attention, last activity, last request, last
outcome, files changed, commits, test/typecheck/autoreview runs, and errors.
It reads only loaded items; `hydrate: true` loads a bounded tail for up to 5
unloaded threads. `falcondeck_thread_changes` with `since` (RFC 3339 or `15m`,
`2h`, `1d`) lists threads active since then with a one-line delta, blocked
threads first; pass its `Now:` value as the next `since`. Approvals and
questions are answered only in the FalconDeck UI.

Use `falcondeck_create_thread` for independent sibling work. The workspace is
inherited. Optional arguments: `provider`, `isolation` (`project_folder`, the
default, or `isolated`), `model`, and `prompt` (up to 24000 characters). Without
`prompt`, the new thread stays idle. `context` defaults to `none`: no parent
transcript is copied. Choose `briefing` for the parent's summary and cached user
excerpts, or `transcript_tail` for up to 40 items / 12000 characters of handoff
markdown. Explicit context is held for the first prompt if none is supplied.

Creation returns after starting the thread and dispatching any first prompt;
it does not wait for completion. Use list/view to check progress. The daemon
stamps the parent as spawn origin and allows at most three concurrent children
per parent. Running, waiting, queued, and unused idle children consume a slot;
completed/error children release it; archiving releases an unused idle child,
but an archived child that is still running or waiting continues to count. Tool approvals and questions
stay in the existing FalconDeck UI. If first-prompt dispatch fails, the result
still identifies the created thread; do not blindly create a duplicate.

Use `falcondeck_message_thread` to send `message` (1–24000 characters) to an
existing `thread_id` in this workspace. Find the id with list and read its
recent work with view first. Messages are labelled with the sending thread id
and title. `delivery` defaults to `steer`: inject into an active turn when
supported, otherwise queue; an idle target starts a new turn. Prefer direct
steering for coordination, corrections, status requests, and results relevant
to the recipient's current work. Choose `queue` only when the message should
wait until its current turn finishes. Self-messaging is rejected. The tool returns
admission status (`steered`, `queued`, or `turn started`), not the recipient's
reply; use view to read replies. Existing target settings and UI approvals
apply. Send only when the user's task authorizes contacting another agent.

## Coordinating children

`falcondeck_create_thread` also takes `title`, `folder` (folder id or exact name;
add `create_folder: true` to create it), and `notify_parent`. Leave
`notify_parent` false by default. Enable it only when notifying the parent is
critical or the user explicitly requests these updates. For routine delegated
work, read thread summaries at natural checkpoints.

With `notify_parent: true`, FalconDeck queues a daemon-labelled notice to this
thread whenever the child needs input or stops running, including later turns.
The flag does not filter for critical events. When notifications are warranted
and enabled, dispatch children, then end your turn; do not poll in a loop.
Notices do not survive a daemon restart.

`falcondeck_wait_thread` waits up to 25 seconds for one thread to stop running.
It reports the status and the pending requests with the ids needed to answer.
`falcondeck_answer_question` answers a plain question from a child this thread
created. Approvals, plan approvals, MCP prompts, and secret questions stay with
the user in FalconDeck UI, so tell the user when one is blocking.

`falcondeck_interrupt_thread` stops another thread's running turn.
`falcondeck_organize_thread` archives, pins (`global`/`project`/`none`), or moves
a thread to a project folder. Interrupt or archive only work you started or the
user asked you to manage.

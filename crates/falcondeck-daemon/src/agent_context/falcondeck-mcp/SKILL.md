---
name: falcondeck-mcp
description: Use FalconDeck session tools for coordination, task outcomes, follow-ups and notifications; read the control skill for settings and schedules.
---

# FalconDeck MCP

This session has FalconDeck MCP tools. Use them when they help with the user's
task; do not wait for the user to name them.

Before finishing, remove temporary worktrees, target dirs and /tmp outputs you created; keep only artifacts linked in your report.

## Servers

- `falcondeck` — control plane: `falcondeck_search`, `falcondeck_get`,
  `falcondeck_execute`.
- `falcondeck-extensions` — session tools, including
  `falcondeck_suggest_follow_ups`, `falcondeck_rename_thread`,
  `falcondeck_list_threads`, `falcondeck_thread_summary`,
  `falcondeck_thread_changes`, `falcondeck_view_thread`,
  `falcondeck_message_thread`, `falcondeck_create_thread`,
  `falcondeck_wait_thread`,
  `falcondeck_organize_thread`, `falcondeck_interrupt_thread`,
  `falcondeck_answer_question`, and `falcondeck_notify`.

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

## Notifying the user

`falcondeck_notify` sends a push with a preview and keeps it in the user's
notification centre, with an optional Markdown report (`body`) they can read on
their phone even while the Mac is asleep.

Use it when something important happened and **no decision is needed**: a launch
finished, an incident is over, a result they asked to hear about arrived. If they
must decide, publish a review instead: a review asks for a decision, a notice
does not.

It is rare by design. Your final reply already reaches them, so never use it for
progress, routine completions or anything your reply says anyway. The exception
is a thread created for a bot's scheduled run: the final reply stays in the thread
without an alert, so a result they must hear about needs a notice. A schedule
that runs in a home or current thread alerts as usual. Limits per sender: 3 an hour, 10 a
day, 2 `importance: "high"` a day; all agents together share 30 a day, with the
last 5 kept for `high`. A retry of the same notice within the hour is not sent twice.
`high` also pushes while they are at the Mac, so keep it for what would justify
an interruption. Pushes are not end-to-end encrypted: keep secrets out of `title`
and `summary`. `body` is encrypted.

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
`parent` (`"self"` also includes open message delegations), `provider`, `folder`, `pinned`, and
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

A limited number of children per parent are active at once (a user setting,
Settings → General → Parallel tasks per agent; default five, 1–20). The
`falcondeck_create_thread` description states the current limit, and a refused
create names it. Running, waiting, queued, and unused idle children count;
finished or errored ones do not. Archiving releases an unused idle child but
not a running one.

### Following up

Both create and message tools accept `result_delivery`: `batch` (default) for
plain completion reports in the bot home's next turn, or `wake` when the result
needs action. Follow-ups preserve the stronger existing setting. Failures,
input requests, interruptions and overdue waits request a wake regardless of
that setting. Only accepted report turns spend the three/hour, six/day per-bot
budget; failed sends back off without consuming it. Paused or archived bots are not woken. `notify_parent: true`
remains the legacy creation opt-in for completion wakes.

Daemon tracking and its bounded outbox survive restarts. Only the current bot
home receives reports; fresh scheduled runs cannot consume them. After reading,
the home calls `falcondeck_acknowledge_results` once with the supplied report_ids.
Acknowledgement confirms receipt only; use `falcondeck_close_delegation`
(`thread_id`, optional `abandon`) to resolve open work.
Provider startup confirms receipt but does not remove reports; failed ACP
startup leaves them unreceived. Full details appear in at most three accepted
home contexts, then collapse. Unread results, including batch completions, have
a daily fallback. Urgent results unreceived for two hours escalate once to James. Do not acknowledge reports by messaging their source.
Reports expire after seven days; consult native task history for older outcomes.

A pending task declares `falcondeck_task_state` with state `waiting`, a reason
and a future RFC3339 deadline. Waiting is informational; polling it does not
start a paid coordinator turn. A missed deadline emits one attention report; work stays open. Unmarked work
gets a configurable four-hour inactivity deadline (zero disables it). Declare `finished` when done; a bot resolving its own task does not
wake itself about that declaration.

For detached jobs call `falcondeck_watch_job` with `pid` and/or absolute
`result_file`, plus a future RFC3339 `deadline`; it persists a wake, declares
waiting, and survives daemon restart. Verify the result before retrying work.

`falcondeck_wait_thread` waits up to 25 seconds for one thread to stop running
and reports its state, request and reply, plus pending requests with the ids
`falcondeck_answer_question` needs. That answers plain questions from your own
children; approvals, plan approvals, MCP prompts and secret questions stay with
the user, so tell them when one is blocking.

`falcondeck_interrupt_thread` stops another thread's running turn.
`falcondeck_organize_thread` archives, pins (`global`/`project`/`none`), or
moves a thread to a folder. Interrupt or archive only work you started or the
user asked you to manage.

For bot schedules: Choose the home/current thread only when a run needs conversation context (such as a launch discussed at length). Otherwise use new_each_run with target.run_as_bot set to the bot id; write explicit criteria for sending one message home, otherwise update STATUS.md and finish silently.

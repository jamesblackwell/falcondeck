---
name: falcondeck-mcp
description: Use FalconDeck MCP tools during a turn. Call falcondeck_suggest_follow_ups near the end of work to offer next actions, falcondeck_rename_thread when the conversation's purpose has changed, and falcondeck_search/get/execute when the user wants automations or FalconDeck settings. Use these tools without waiting to be asked by name.
---

# FalconDeck MCP

This session has FalconDeck MCP tools. Use them; they are part of the product,
not optional flavour.

## Servers

- `falcondeck` — control plane: `falcondeck_search`, `falcondeck_get`,
  `falcondeck_execute`.
- `falcondeck-extensions` — session tools, including
  `falcondeck_suggest_follow_ups`, `falcondeck_rename_thread`,
  `falcondeck_list_threads`, `falcondeck_view_thread`, and `falcondeck_create_thread`.

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

Use `falcondeck_list_threads` to find work in this workspace. Results are bounded
markdown summaries with last previews and cached opening/recent user excerpts,
when available; listing does not load transcripts. `limit` defaults to 30 (max
100), and `max_chars` defaults to 24000 (512–24000).

Use `falcondeck_view_thread` with `thread_id` to read handoff markdown. `limit`
defaults to 40 items (max 100); `max_chars` has the same bounds as list. The
newest content wins when the character budget fills. Individual bodies may be
truncated. Pass the returned `before` item id to read older content.

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

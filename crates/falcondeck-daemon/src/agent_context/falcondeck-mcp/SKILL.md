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
  `falcondeck_suggest_follow_ups` and `falcondeck_rename_thread`.

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

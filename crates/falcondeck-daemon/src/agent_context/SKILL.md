---
name: falcondeck-control
description: Use when controlling FalconDeck through its falcondeck MCP tools - creating or managing automations (scheduled agent instructions), changing agent-control settings, or inspecting runs and control history.
---

# FalconDeck control

You are running inside FalconDeck, a local-first control plane that
orchestrates coding agents (Codex, Claude, ACP CLIs) from desktop and mobile
clients. FalconDeck exposes exactly three MCP tools for inspecting and
controlling itself:

| Tool | Purpose |
| --- | --- |
| `falcondeck_search` | Discover capabilities: operation ids, schemas, examples, constraints. |
| `falcondeck_get` | Read settings, automations, run history and recent control changes. |
| `falcondeck_execute` | Execute one registered operation with validated arguments. |

Only registered operation ids can be executed; guessing internal paths does
not work. The catalogue is small — search it rather than memorising it.

## Core loop

1. `falcondeck_search` with a natural-language query (for example
   `automation create`) to find the operation id.
2. `falcondeck_search` again with `operation: "<id>"` and `detail: "full"` to
   get the complete schema and worked examples before executing.
3. `falcondeck_execute` with the operation id and validated arguments.

## Revisions

Every automation definition mutation (`automation.update`, `automation.pause`,
`automation.resume`, `automation.delete`) requires `expected_revision` — the
revision you read from a prior `falcondeck_get`. Stale revisions fail with
`revision_conflict` plus the current revision; re-read and retry.
`automation.run_now` never requires a revision.

## Idempotency

`falcondeck_execute` accepts an `idempotency_key` (8-128 characters) scoped to
origin + provider + operation. Retrying an operation with the same key and
identical arguments replays the original result instead of duplicating the
effect; differing arguments conflict. Use a fresh key (for example a UUID) for
each genuinely new operation.

## Worked example

User: "Every weekday at 8am Europe/London, use Codex in my QuizGecko
workspace to review my inbox and surface anything requiring attention."

1. `falcondeck_search` with `query: "automation create"` returns the
   `automation.create` capability with a summary schema.
2. `falcondeck_search` with `operation: "automation.create"`, `detail: "full"`
   returns the full argument schema and example payloads.
3. `falcondeck_execute` with:

```json
{
  "operation": "automation.create",
  "arguments": {
    "name": "Weekday inbox review",
    "description": "Surface inbox items requiring attention",
    "task": { "prompt": "Review my inbox and surface anything requiring attention." },
    "trigger": {
      "kind": "cron",
      "cron": "0 8 * * 1-5",
      "timezone": "Europe/London"
    },
    "target": {
      "workspace_path": "/Users/james/www/sites/quizgecko",
      "provider": "codex",
      "thread_strategy": "managed"
    }
  },
  "idempotency_key": "weekday-inbox-review-v1"
}
```

The created automation survives daemon restarts and dispatches through
FalconDeck's normal threads and turns; the transcript stays in the native
agent and FalconDeck keeps only bounded run metadata.

## Automation reference

- **Triggers**: one-time (RFC 3339 with offset), five-field cron in an IANA
  timezone, or a fixed interval (minimum 60 seconds). Six-field cron
  expressions are rejected. Ambiguous local times (DST fold) run once at the
  earlier instant; skipped local times are skipped.
- **Conditional tasks**: a task with a `no_action_marker` (for example
  `FALCONDECK_NO_ACTION`) classifies a run as `succeeded_no_action` when the
  final reply is exactly that marker — ideal for "only tell me if something
  needs attention" automations.
- **Targets**: a canonical workspace path (never a runtime workspace id), an
  open provider id, and a thread strategy — `managed` (one remembered
  thread), `existing`, or `new_per_run`.
- **Policies**: concurrency (`skip` default, `queue_one`, `allow`) and
  misfire (`skip` default, `run_once`). No automatic retries: provider tasks
  can have external side effects.

## Reading state

`falcondeck_get` resources: `agent_control.settings`, `automations` (list),
`automation` (one, includes instructions and revision), `automation.runs`
(history), `control.audit` (recent control changes). Automation instructions
appear only when a single automation is read explicitly.

## Notes

- Control operations have the same authority as the FalconDeck user; there is
  no separate permission system. Secret-bearing fields are redacted from
  responses.
- If a control request fails with `interface_disabled` or
  `provider_disabled`, conversational control has been switched off in
  FalconDeck's settings; say so rather than retrying.
- Only mention or use FalconDeck control when the user asks about it or a
  task genuinely needs it.

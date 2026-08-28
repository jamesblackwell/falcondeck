# Agent Control

FalconDeck exposes a small conversational control interface so the agents you
already run — Codex, Claude, and ACP-compatible CLIs — can configure
FalconDeck itself: inspect state, and create and manage **automations**
(scheduled agent instructions).

This document covers user-facing behaviour and the implementation contract.
The full product specification lives in `docs/agent-control-prd.md`.

## The three tools

Agents see exactly one FalconDeck MCP server (`falcondeck`) with three tools:

| Tool | Purpose |
| --- | --- |
| `falcondeck_search` | Discover capabilities: operation ids, schemas, examples, constraints. |
| `falcondeck_get` | Read settings, automations, run history and recent control changes. |
| `falcondeck_execute` | Execute one registered operation with validated arguments. |

The catalogue is fixed; new capabilities grow the registry behind
`falcondeck_search` rather than the tool list. Unsupported operations cannot
be executed by guessing internal paths — only registered operation ids are
accepted.

## Example conversation

> Every weekday at 8am Europe/London, use Codex in my QuizGecko workspace to
> review my inbox and surface anything requiring attention.

The agent searches for `automation.create`, reads the schema, and executes it
with a structured trigger. The created automation is stored by the daemon,
survives restarts, and dispatches through FalconDeck's normal threads and
turns — the thread and its transcript stay in the native agent, FalconDeck
keeps only bounded run metadata.

## Automations

- **Triggers**: one-time (RFC 3339 with offset), five-field cron in an IANA
  timezone, or a fixed interval (minimum 60 seconds). Six-field cron
  expressions are rejected. Daylight-saving is explicit: ambiguous local
  times run once at the earlier instant; skipped local times are skipped.
- **Tasks**: plain prompts, or *conditional* prompts that classify a run as
  `succeeded_no_action` when the final reply is exactly the configured
  no-action marker (e.g. `FALCONDECK_NO_ACTION`).
- **Targets**: a canonical workspace path (never a runtime workspace id), an
  open provider id, and a thread strategy — managed (one remembered thread),
  existing, or new-per-run.
- **Policies**: concurrency (`skip` default, `queue_one`, `allow`) and
  misfire (`skip` default, `run_once`). No automatic retries: provider tasks
  can have external side effects. One-time automations become `completed`
  after their execution attempt.
- **Revisions**: every definition mutation requires the revision that was
  read (`expected_revision`); stale edits fail with `revision_conflict` and
  the current revision. `run_now` never requires a revision.
- **Idempotency**: `falcondeck_execute` accepts an idempotency key scoped to
  origin + provider + operation; identical retries replay the original
  result, differing arguments conflict.

## Agent context injection

So agents know they are running inside FalconDeck and how to use the control
tools, the daemon injects a small amount of context at every provider spawn
boundary — the same boundaries where the built-in connector is injected:

- **Short always-on append** (~6 lines): tells the agent it is operating via
  FalconDeck, names the three `falcondeck_*` tools and the
  search → get → execute workflow, and points at the full guide below. Sent
  as Claude `--append-system-prompt`, Codex `developerInstructions`
  (thread/start and thread/resume), and ACP `session/new` `instructions`
  (omitted when empty so older ACP agents are unaffected).
- **Bundled `falcondeck-control` skill** staged to
  `<state dir>/skills/falcondeck-control/SKILL.md`: the full usage guide
  (core loop, revisions, idempotency, worked examples). Codex receives the
  skills directory through app-server `skills/extraRoots/set` at process
  start (failure is tolerated on older app-servers); Claude and ACP agents
  reach it through the path in the append. Progressive disclosure: the skill
  costs context only when an agent reads it.

Both are covered by the `inject_agent_context` setting (default on) in
**Settings → Agent control** or through `agent_control.settings.update`, and
are skipped entirely when agent control is disabled for the provider. The
append applies on the next turn (Claude) or next agent process start (Codex,
ACP).

## Enablement

Agent control is enabled by default. The desktop **Settings → Agent
control** panel (or `agent_control.settings.update` through the tools) can
disable it globally or per provider:

- Disabled providers stop receiving the built-in connector, and stale MCP
  processes are rejected server-side on every request with
  `interface_disabled` / `provider_disabled`.
- The desktop interface and scheduled automations are unaffected: disabling
  conversational control never pauses the scheduler.

Elevated permission modes (`bypassPermissions`, `danger-full-access`) require
`allow_elevated_automations` and are badged in the interface.

## The built-in connector

The daemon injects the `falcondeck` MCP server in memory at every provider
spawn boundary — Claude per turn (with thread context), Codex at app-server
start, ACP per session. It is never written to `connectors.json`, and a user
connector with the reserved name is ignored with a warning. The subprocess is
`<daemon executable> mcp`; it talks to the daemon's control API over loopback
and owns no state itself.

## Desktop

- **Settings → Agent control**: global/provider toggles, default timezone,
  elevated-automation switch, agent-context injection toggle, recent control
  changes (audit).
- **Sidebar → Scheduled**: the single automation/task manager. It combines
  canonical control records with any non-losslessly-convertible legacy
  scheduled records, routes actions to the owning daemon/store, and removes
  stable-id duplicates during migration. Create/edit uses the same validated
  control payloads as conversational tools; pause/resume/run-now, history, and
  delete remain host-owned. `control-state-changed` events make conversational
  changes appear immediately.

## Mobile

- **Sidebar → Automations** exposes the same list, editor, pause/resume,
  run-now, history, and delete operations as desktop.
- Mobile sends generic `control.get` and `control.execute` RPCs through the
  existing end-to-end encrypted relay channel. The daemon attaches the
  `remote_rpc` origin and remains the only writer, so validation, revisions,
  idempotency, audit records, and scheduler wakeups are identical to desktop.
- Definitions, settings, and recently opened run histories are cached in
  session-scoped MMKV storage. The cached list renders immediately on launch
  and remains read-only while the daemon is offline; a stale-while-revalidate
  fetch replaces it when RPC readiness returns.
- Unified `control-state-changed` events invalidate the affected mobile view.
  Bursts are coalesced before refetching, and full automation instructions
  remain detail-only rather than entering the daemon snapshot or relay replay.

## Persistence and bounds

Canonical state lives in `~/.falcondeck/agent-control.json` beside the daemon
state file (schema versioned, atomic 0600 writes). Compatible definitions in
the retired `scheduled-tasks.json` store migrate into it under their existing
ids; non-lossless RRULE records remain compatibility-owned and visible only
through the same Scheduled dashboard. Retention: 100 runs per
automation, 1,000 runs total, 500 audit entries, 128 idempotency records /
24 hours, 1,000-character outcome previews. A malformed file is preserved
under a recovery name and scheduling stays disabled until it is fixed; an
unrecognized future schema version is never overwritten.

## Security model

The interface has the same effective authority as the FalconDeck user and
the target provider configuration. Loopback host and browser-origin
protections are unchanged; the MCP subprocess identifies itself through
internal headers the model cannot set inside tool arguments. Known
secret-bearing fields are redacted from every model-facing response;
connector credentials are never returned; automation instructions appear
only when a single automation is read explicitly, never in lists or audit
summaries.

## Architecture notes

```
crates/falcondeck-core/src/control.rs          shared wire types + event
crates/falcondeck-daemon/src/agent_context.rs  append + bundled skill staging
crates/falcondeck-daemon/src/control/
  service.rs   ControlService: search/get/execute, revisions, idempotency
  registry.rs  capability catalogue + deterministic search (schemars)
  automations.rs  cron/interval/once engine, DST + misfire semantics
  store.rs     agent-control.json, bounds, cursors, projections
  scheduler.rs notify-driven dispatch through workspace/thread/turn machinery
  redaction.rs secret redaction
  mcp.rs       the stdio MCP server (`falcondeck-daemon mcp`)
apps/desktop/src/components/…                 settings + Scheduled dashboard
apps/mobile/src/features/automations/          mobile payloads + event invalidation
apps/mobile/src/store/automation-store.ts      relay reads/mutations + MMKV cache
packages/client-core/src/control.ts            TS types and normalizers
```

Rules that keep the design honest:

1. The daemon is the sole writer of control state; the MCP process is a
   stateless proxy.
2. One source of behaviour: the desktop UI and the MCP tools call the same
   control service through the same three HTTP routes
   (`/api/control/search|get|execute`).
   Paired clients reach `get` and `execute` through equivalent encrypted
   relay RPC registrations.
3. Automations invoke agents through the existing thread/turn machinery —
   there is no separate conversation store.
4. Automations store canonical workspace paths; runtime workspace ids appear
   only in run records.

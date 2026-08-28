# Scheduled tasks

Status: V1 implemented 2026-08-13; persistence converged 2026-08-28.

The daemon-owned scheduler, local and enrolled-host RPCs, durable task/run
storage, unified events, generated-thread provenance, and desktop Scheduled UI
are implemented. Agent-driven creation through a bundled skill/MCP bridge and
the opt-in macOS LaunchAgent remains a deferred follow-up.

`agent-control.json` is now the canonical definition and run store for work
created from either chat or the desktop Scheduled page. The original
`scheduled-tasks.json` contract remains as a compatibility reader/executor:
losslessly representable daily, weekly, and one-time records migrate at daemon
startup under the same stable ids, with their execution settings and run
history. RRULEs that cannot be represented exactly by the control scheduler
remain legacy-owned and are projected into the same Scheduled dashboard. A
stable-id dashboard dedupe and control-first migration order ensure that no
record is shown or executed twice during the two-file transition.

## 1. Product decision

FalconDeck scheduled tasks are a daemon capability. Each task belongs to the
daemon that will execute it:

- a task created on **This Mac** runs while the local daemon is running;
- a task created on an enrolled server runs in that server's standalone daemon
  and continues when the desktop client is closed;
- desktop, remote web, and mobile are clients that create, inspect, pause, and
  resume tasks through the owning daemon;
- the relay transports encrypted RPCs, events, replay, and notifications, but
  never schedules or executes work.

The execution host is therefore not a field that can be changed inside a
daemon-owned task. Host selection is routing performed by the client before it
sends the create request. A task may be copied to another host, but it cannot be
silently moved because paths, repositories, credentials, providers, skills,
and connectors are host-local.

This follows FalconDeck's existing rule: the daemon is the product and the UI
is one of several clients. It also preserves native agent ownership of sessions
and conversation history. FalconDeck stores task definitions and a bounded run
ledger; Codex, Claude, or an ACP provider continues to own each generated
session.

## 2. V1 scope

V1 delivers useful scheduled work without requiring background-service changes
on macOS or agent-driven task creation.

### Included

- one-time and recurring schedules;
- explicit IANA timezone handling;
- create, edit, pause, resume, run now, and delete;
- host, project, provider, model/mode, prompt, skills, isolation, and permission
  selection;
- one fresh native agent thread per run;
- local and enrolled-server execution using the same daemon implementation;
- bounded run history with links to the native FalconDeck thread;
- task and run state in snapshots and the unified event stream;
- a Scheduled page on desktop, visually aligned with ChatGPT's quiet list UI
  but using FalconDeck components and tokens;
- completion, failure, and input-required attention using the existing
  notification pipeline;
- remote RPC parity so the desktop can manage server-owned tasks.

### Deferred from V1

- returning to the same thread on every run;
- semantic monitoring that suppresses uneventful results;
- schedules contributed by third-party extensions;
- creating or changing tasks directly from an agent chat;
- an always-on macOS LaunchAgent;
- mobile and remote-web authoring UI (read-only visibility may land earlier);
- cross-host migration or centrally owned schedules;
- arbitrary cron expressions in the primary UI.

The protocol should leave room for these without implying that they ship in
V1.

## 3. Product model

### Task definition

Add the canonical types to `falcondeck-core` first and mirror them in
`packages/client-core`:

```rust
pub struct ScheduledTask {
    pub id: String,
    pub title: String,
    pub status: ScheduledTaskStatus,
    pub schedule: ScheduledTaskSchedule,
    pub workspace_id: String,
    pub prompt: String,
    pub provider: AgentProvider,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub collaboration_mode_id: Option<String>,
    pub approval_policy: Option<String>,
    pub sandbox_mode: Option<String>,
    pub permission_mode: Option<String>,
    pub isolation: ThreadIsolation,
    pub selected_skills: Vec<SelectedSkillReference>,
    pub next_run_at: Option<DateTime<Utc>>,
    pub last_run: Option<ScheduledTaskRunSummary>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
```

The exact Rust shape can use nested execution settings to avoid a wide struct,
but the wire contract must keep these concepts explicit and additive.

`ScheduledTaskSchedule` has two V1 forms:

```text
once       { run_at, timezone }
recurring  { rrule, timezone }
```

Use RFC 5545 RRULE as the stored recurrence representation and an IANA timezone
such as `Europe/London`. The UI supplies presets and a structured custom editor;
RRULE is an advanced representation and protocol contract, not the main user
experience. Never derive behavior from the server's local timezone.

Task statuses are `active`, `paused`, and `completed`. A one-time task becomes
`completed` after a terminal run. Deleting remains a distinct, explicit action.

### Run ledger

Each invocation receives a stable run id and records:

- scheduled time and actual start time;
- `queued`, `running`, `awaiting_input`, `succeeded`, `failed`, `interrupted`,
  or `skipped` state;
- native FalconDeck workspace/thread id;
- completion time and a short failure or result preview;
- whether it was scheduled, late after restart, or manually started.

Do not store transcript bodies in the task ledger. Clicking a run opens the
native provider-backed thread. Retain a bounded number of run summaries per
task (initially 50) and keep full conversation history under the harness's
normal retention behavior.

### Host provenance

The daemon snapshot contains only that daemon's tasks. Client aggregation adds
the existing `HostView.id` and display name, just as project operations are
routed through `apiFor`. Do not persist a desktop-local host id inside the
server's task record.

Add daemon capability negotiation such as
`daemon.capabilities.scheduled_tasks = true`; clients must not infer support
from a version string. An older enrolled server remains visible and simply
disables scheduled-task actions with an upgrade message.

## 4. Scheduling semantics

Define these semantics before adding UI:

1. The daemon calculates and persists `next_run_at` after every definition or
   run-state change.
2. Only one run of the same task may execute at a time. If another occurrence
   arrives, V1 coalesces it into at most one pending run rather than starting
   overlapping mutations in the same checkout.
3. Recurring occurrences missed while a daemon is offline are skipped; the
   daemon schedules the next future occurrence. This avoids a burst of stale
   work after a laptop or server returns.
4. A missed one-time task runs once when the daemon next starts and is marked
   late. The task then completes.
5. Pausing never interrupts a running invocation; it prevents subsequent
   invocations. `Run now` is permitted for a paused task but does not resume it.
6. Deleting a task does not delete its generated agent threads. If a run is
   active, deletion requires confirmation and interrupts it before removing the
   definition.
7. V1 enforces a minimum recurring interval (proposed: five minutes) and a
   per-daemon concurrency limit (proposed: two scheduled runs). Both limits
   should be constants with tests before they become settings.
8. Wall-clock changes and daylight-saving transitions are resolved from RRULE
   plus the stored timezone. Store instants in UTC and preserve the user's
   timezone for future calculations and display.

Use an injected clock in scheduler tests. Do not build timing tests around real
sleeps.

## 5. Daemon architecture

Add a `scheduled_tasks` module with four separable responsibilities:

```text
definition store -> recurrence calculation -> scheduler loop -> run dispatcher
```

### Persistence

Store canonical task definitions and the bounded ledger in the schema-versioned,
atomic `agent-control.json` file. `scheduled-tasks.json` is retired persistence
read only through the compatibility API and migration layer; it must not receive
new definitions from the Scheduled UI. Both remain separate from the closed
`daemon-state.json` structure.

On restoration:

- load and validate definitions before starting the scheduler loop;
- mark any persisted `running` run as `interrupted` because its owning daemon
  process disappeared;
- apply the missed-run policy;
- publish the restored task summaries in the first authoritative snapshot.

### Scheduler loop

Use one daemon-owned Tokio task, a priority queue ordered by `next_run_at`, and
a `Notify`/channel that wakes the loop whenever CRUD changes the queue. Avoid
one timer task per definition. Recompute from persisted recurrence state after
every wake so clock changes and edits converge cleanly.

The scheduler must shut down with `AppState`, before provider runtimes and the
HTTP server are disposed. No scheduled run should start after shutdown begins.

### Run dispatch

Reuse `AppState::start_thread` and the existing turn-start path. Do not invoke
Codex, Claude, or ACP adapters directly from the scheduler. That preserves
provider capability handling, connector materialization, selected skills,
permissions, event normalization, persistence, and native-session ownership.

Attach internal run provenance when starting the thread so `TurnEnd`, failures,
interruptions, and interactive requests can update the ledger. Expose a small
client-facing origin on `ThreadSummary` so generated threads can show
`Scheduled · <task title>` without provider-specific logic.

If the selected workspace, provider, model, or skill is no longer available,
fail the run visibly; do not silently fall back to another host or provider.

### Permissions and unattended execution

A task captures its execution permissions at creation and displays them in the
editor and detail view. Scheduled work must not inherit whatever permission
mode the user most recently selected in another thread.

When a provider requests input or approval, mark the run `awaiting_input` and
use the existing interactive-request and notification flows. Do not invent a
second approval store. A run may continue after the user responds through any
paired client.

Full-access and project-folder tasks require an explicit warning because they
can modify a live checkout unattended. Isolation remains opt-in, matching
FalconDeck's same-folder default, but the editor should recommend isolation for
recurring mutating work.

## 6. Protocol and client changes

### Core protocol

Add:

- `ScheduledTaskSummary`, `ScheduledTaskDetail`, `ScheduledTaskRunSummary`;
- create and patch request types;
- task and run status enums;
- task origin on generated threads;
- scheduled task summaries in `DaemonSnapshot`;
- `ScheduledTaskCreated`, `ScheduledTaskUpdated`,
  `ScheduledTaskDeleted`, `ScheduledTaskRunStarted`, and
  `ScheduledTaskRunUpdated` unified events;
- a daemon capability flag for scheduled tasks.

Keep the snapshot bounded: task summaries and the latest run belong there;
full prompts and run history are fetched on demand.

### Local HTTP

Proposed routes:

```text
GET    /api/scheduled-tasks
POST   /api/scheduled-tasks
GET    /api/scheduled-tasks/{task_id}
PATCH  /api/scheduled-tasks/{task_id}
DELETE /api/scheduled-tasks/{task_id}
POST   /api/scheduled-tasks/{task_id}/run
GET    /api/scheduled-tasks/{task_id}/runs
```

These routes remain a compatibility contract for legacy clients and records.
New desktop creation and all conversational creation use `control.get` and
`control.execute`; pause/resume, run-now, history, and definition edits are
routed to the store that owns the row.

### Encrypted remote RPC

Add matching methods to both `REMOTE_RPC_METHODS` and
`dispatch_remote_rpc` in the same change:

```text
scheduled.list
scheduled.create
scheduled.detail
scheduled.update
scheduled.delete
scheduled.run
scheduled.runs
```

Extend the registration/dispatcher parity test. Paired clients already have
authority to start full-access agent turns and edit connectors, so scheduled
task writes use the same trust boundary and emit visible service events.

### TypeScript client core

Mirror and normalize all new types in `packages/client-core`, add local and
remote client methods with the same shapes, and extend snapshot/event reducers.
Scheduled task operations are host-scoped rather than workspace-only. The
existing `WorkspaceScopedApi`, `HostView`, and `apiFor` aggregation layer lives
in `apps/desktop/src/hosts.ts`, not client core; add a small `HostScopedApi`
there for V1 while keeping the underlying single-daemon task methods shared in
`packages/client-core`. Do not force host operations through a fake workspace
id.

## 7. Desktop UI

Add a first-class **Scheduled** destination above the project list, with a
clock icon and unread indicator. Extend the shared sidebar shell with a semantic
top-level navigation slot rather than hardcoding the row separately in every
client.

The page should follow the reference hierarchy while using FalconDeck's design
system:

```text
Scheduled tasks                                      [New task]
Run recurring agent work on this Mac or a server.

[ Search scheduled tasks................................. ]
[ All ] [ Active ] [ Paused ]                  [Host: All]

○ Daily briefing
  Daily at 09:00 · Next run in 18 hours · quizgecko-ops-2

○ Review recent changes
  Mondays at 09:00 · falcondeck · This Mac
```

Requirements:

- search title, prompt summary, project, and host label;
- All, Active, and Paused filters;
- an explicit host filter once more than one host supports tasks;
- status, human schedule, next run, project, provider, and host on each row;
- row click opens a detail side panel with prompt, execution settings, recent
  runs, and `Open thread` links;
- row context menu contains Run now, Edit, Pause/Resume, and Delete, following
  existing menu placement and destructive-action conventions;
- offline/old hosts remain visible with stale/unsupported treatment and disabled
  mutation controls;
- all styling uses `--fd-*` tokens and semantic shared components;
- loading, empty, no-search-results, unsupported-host, and failure states;
- keyboard focus, screen-reader names, reduced-motion behavior, and no
  hover-only actions.

This is the only desktop management surface. Agent-control settings configure
access and safety defaults, but do not contain a second automation list.
Control-state events refresh local rows immediately; paired-host events carry
the owning daemon's control revision and refetch that host.

The **New task** flow should be a focused sheet or page, not an overloaded
single modal. Fields:

1. title and durable prompt;
2. execution host;
3. project on that host;
4. one-time or recurring schedule, timezone, and presets;
5. provider/model/mode and selected skills;
6. project folder or isolated checkout;
7. permission/sandbox mode and notification behavior;
8. a final plain-language summary before save.

Offer `Run once now` after creation so users can validate the prompt before
trusting recurrence. The first failed runs should be prominent rather than
buried in history.

### Aggregating hosts

Do not merge tasks anonymously into the existing flattened snapshot. Build a
memoized list of `{ host, task }` pairs from the local snapshot and each
`HostView.snapshot`. Route writes through the owning local or remote client.
This makes duplicate ids harmless, preserves host labels, and makes offline
state explicit.

Desktop is the V1 authoring surface. Remote web and mobile should first receive
the protocol, snapshot reducers, run links, and notification routing, then gain
equivalent management screens using shared logic and platform-appropriate
presentation.

## 8. Creating scheduled tasks through chat

Chat-driven scheduling is valuable, but it should be a façade over the same
daemon API, not a second scheduling implementation.

### Recommendation: built-in control MCP plus a skill

Use both mechanisms for different jobs:

- **MCP tools** provide live, structured reads and actions against the current
  FalconDeck daemon.
- **A bundled skill** teaches the agent when to use those tools, how to ask for
  missing schedule/host/permission details, and how to present the result.

A skill alone cannot securely mutate FalconDeck. An MCP tool with no workflow
guidance produces a brittle interview. Together they remain provider-neutral:
FalconDeck already materializes MCP servers for Codex, Claude, and ACP agents,
and its selected-skill path can provide equivalent durable instructions.

Do not put the built-in control server into the user's `connectors.json`.
Inject it as a FalconDeck system connector at provider spawn/session
boundaries, scoped to the current daemon and workspace. It should be separately
discoverable and disableable in settings, and user connectors must not be able
to override its reserved name.

### Safe mutation flow

The first chat integration should create **drafts**, not silently commit
durable automation:

1. The user asks the agent to schedule or change work.
2. The agent calls a FalconDeck tool to create a structured proposal.
3. The daemon emits a pending scheduled-task draft tied to the current thread.
4. FalconDeck renders a native confirmation card containing host, project,
   prompt, cadence, timezone, provider, isolation, and permissions.
5. The user confirms or edits it through a FalconDeck client.
6. The client commits the draft through the normal scheduled-task API.

This confirmation is enforced by FalconDeck and does not depend on each
harness interpreting tool approvals consistently. Read-only tools such as
listing tasks can return immediately.

Initial MCP surface:

```text
scheduled_tasks_list
scheduled_task_propose_create
scheduled_task_propose_update
scheduled_task_propose_pause
scheduled_task_propose_delete
scheduled_task_run_now
```

`run_now` should also require confirmation when the captured permission mode
is mutating. Later, an explicit user preference may allow trusted low-risk
operations without the draft step.

### Host limitation

An agent tool runs against the daemon hosting that conversation. It can create
a task on that same host without ambiguity. A local thread must not silently
route a task to an enrolled server because the desktop currently owns the host
registry and the remote daemon has different files and credentials.

If the user requests another host, the proposal records an unresolved host
intent and the confirmation card requires the client to choose an enrolled
host and validate project/provider availability before commit. V1 chat support
may simply state that chat-created tasks run on the current host.

## 9. FalconDeck configuration and extension authoring through agents

The broader idea is sound, but static authoring knowledge and live product
control should remain separate.

### Extension authoring

Use a bundled `falcondeck-extension-author` skill plus the CLI planned in
`docs/EXTENSIONS.md`:

```text
falcondeck extension create
falcondeck extension validate --json
falcondeck extension test --json
falcondeck extension dev --json
falcondeck extension pack --json
```

The skill points the harness at the canonical extension contract, manifest
schema, public SDK, fixtures, and restart/reload procedure. Agents already know
how to edit source files and run commands; an MCP response should not dump a
large copy of static documentation into the conversation.

Add live control tools only where the daemon is authoritative:

```text
extensions_list
extension_diagnostics
extension_propose_enable
extension_propose_reload
```

Enablement, permission increases, installation, and reload remain confirmed
daemon operations. The extension SDK's future `agent-tools:register` permission
is separate: it allows an extension to offer domain tools to agents and must
not grant arbitrary FalconDeck administration.

### General configuration

Evolve the built-in MCP as a narrow, capability-shaped control API rather than
one unrestricted `update_settings` tool. Start with read-only introspection and
draft-confirm mutations. Every tool needs:

- a daemon permission check;
- a bounded schema;
- an audit/service event;
- safe behavior through local and relay clients;
- an explicit answer for whether it is available to unattended scheduled runs.

Scheduled runs should not receive FalconDeck administrative tools by default,
otherwise a recurring prompt could rewrite its own schedule or widen its own
permissions. Capture a tool allowlist in the task definition and exclude the
control MCP unless the user grants a future dedicated permission.

## 10. Notifications and attention

Reuse the existing attention pipeline. Add scheduled-run semantic kinds only
where routing differs:

- completion opens the run/thread;
- input-required opens the existing interactive request;
- failure opens the task detail and failed thread.

Avoid sending both a generic turn-complete notification and a scheduled-run
notification for the same terminal event. The daemon should deduplicate at the
semantic source, not rely on push-provider deduplication.

The Scheduled page acts as the durable task/run inbox. Push remains a delivery
channel, consistent with `docs/NOTIFICATIONS.md`.

## 11. Phased implementation

### Phase 0 — contract and scheduler semantics

- finalize this document's V1/deferred boundary;
- add Rust protocol types, TypeScript mirrors, normalization, fixtures, and
  capability negotiation;
- choose and validate the RRULE/timezone dependency;
- write deterministic recurrence, DST, missed-run, and overlap tests.

Gate: Rust and TypeScript fixtures agree, and timing behavior is completely
specified without real-time sleeps.

### Phase 1 — daemon store and scheduler

- versioned atomic definition/run-ledger storage;
- restoration and stale-run reconciliation;
- priority-queue scheduler loop and clean shutdown;
- CRUD, run-now, list/detail, and run-history methods;
- local HTTP routes and unit/integration tests.

Gate: definitions survive restart; one-time/recurring, pause/resume, deletion,
misfires, and concurrency limits pass under a fake clock.

### Phase 2 — agent execution and event integration

- dispatch through existing thread/turn APIs;
- capture run-to-thread provenance;
- update runs from normalized turn and interactive-request events;
- notification deduplication and thread origin presentation;
- project-folder and isolated-run tests across Codex, Claude, and a fake ACP
  provider where available.

Gate: no scheduler code branches on provider id, native session ownership is
unchanged, and provider/request failures become terminal or attention states.

### Phase 3 — relay and host-aware desktop UI

- remote RPC registration and dispatcher parity;
- host-scoped TypeScript clients;
- snapshot/event convergence including relay replay pruning;
- Scheduled sidebar destination, list/search/filter UI, editor, detail panel,
  context actions, and run links;
- local-versus-server labels and unsupported/offline host states.

Gate: a task created from the Mac UI executes on an enrolled server after the
Mac app closes, and its result appears after reconnecting.

### Phase 4 — hardening and cross-client visibility

- retention, corruption, resource-limit, shutdown, and upgrade tests;
- mobile and remote-web snapshot/event support and task/run viewing;
- push notification routing and real-device verification;
- packaged desktop and standalone Linux daemon smoke tests;
- repo-local autoreview before shipping.

Gate: local, server, relay-reconnect, daemon-restart, old-client, and old-server
scenarios fail coherently without losing task definitions or agent sessions.

### Phase 5 — chat-native task drafts

- system MCP bridge scoped to the current daemon/workspace/thread;
- bundled scheduling skill;
- pending-draft protocol and native confirmation card;
- provider-neutral injection for Codex, Claude, and ACP;
- audit events, permissions, and adversarial tool-call tests.

Gate: each supported harness can propose the same task, but no harness can
create, widen, move, or delete a durable task without FalconDeck confirmation.

### Phase 6 — background Mac daemon and richer automation

- opt-in macOS LaunchAgent and stable authenticated local discovery;
- close-window versus quit behavior and start-at-login setting;
- same-thread scheduled continuations;
- semantic monitor outcomes and notification suppression;
- mobile/remote-web authoring;
- permissioned extension schedule and notification facets after a real
  extension demonstrates demand.

## 12. Test matrix

At minimum, cover:

1. recurrence across DST gaps, folds, timezone edits, and clock changes;
2. daemon restart before, during, and after a due occurrence;
3. pause/edit/delete races with a scheduler wake;
4. duplicate run prevention and per-task/global concurrency;
5. missing workspace/provider/model/skill and changed permissions;
6. project-folder and isolated execution cleanup;
7. approval/input-required continuation through desktop and paired clients;
8. task snapshot plus event replay and replay-pruning recovery;
9. old client/new daemon and new client/old daemon capability behavior;
10. server execution while the authoring Mac is offline;
11. task deletion without native-thread deletion;
12. extension/control MCP denial, confirmation, audit, and self-modification
    restrictions;
13. accessibility and keyboard coverage for list, editor, detail, menus, and
    confirmation cards.

## 13. Decisions to confirm before implementation

The plan recommends these defaults:

- fresh thread per run in V1;
- five-minute minimum recurrence;
- two concurrent scheduled runs per daemon;
- recurring missed runs are skipped; missed one-time runs execute once late;
- project-folder execution remains the default, with a strong warning and an
  isolated option;
- desktop is the first authoring surface;
- chat-created tasks arrive after V1 and require a native confirmation draft;
- a bundled skill provides extension-authoring knowledge, while MCP exposes
  live daemon actions;
- local always-on execution waits for an opt-in LaunchAgent phase.

Changing any of these is straightforward before protocol and persistence types
ship; changing them after stored task definitions exist requires compatibility
and migration work.

## 14. Reference behavior

The product behavior was informed by OpenAI's public scheduled-task guidance:

- [Scheduled tasks in ChatGPT](https://learn.chatgpt.com/docs/automations?surface=app)
- [Scheduled Tasks in ChatGPT help](https://help.openai.com/en/articles/10291617-tasks-in-chatgpt)

FalconDeck should copy the useful interaction model—background runs, a
Scheduled inbox, standalone versus contextual work, host/project selection,
and agent-assisted creation—without copying ChatGPT's cloud ownership model.
FalconDeck's defining constraint is that work executes on an explicitly chosen,
daemon-owned host.

# Product Requirements Document: FalconDeck Agent Control Interface

**Status:** Ready for implementation
**Product:** FalconDeck
**Initial release:** Agent control settings, scheduled automations and built-in MCP exposure
**Primary owners:** FalconDeck daemon and desktop client
**Required providers:** Codex and Claude
**Architecture-ready providers:** ACP-compatible agents
**Protocol target:** MCP `2026-07-28`, with compatibility for initialization-based MCP clients
**Document purpose:** Define the product behaviour, domain model, service boundaries, protocol surface, persistence and delivery plan in sufficient detail for implementation

---

## 1. Executive summary

FalconDeck will expose a built-in agent control interface that allows users to inspect and operate FalconDeck conversationally from supported agent providers.

A user should be able to say:

> Every weekday at 8am, use Codex in my QuizGecko workspace to review my inbox and surface anything requiring attention.

The agent will discover the appropriate FalconDeck capability, submit a validated operation and receive a concise structured result. The automation will be stored and scheduled by the FalconDeck daemon, independently of the conversation that created it.

The public model-facing interface will remain deliberately small:

* `falcondeck_search`
* `falcondeck_get`
* `falcondeck_execute`

These tools will sit above a daemon-owned control service and capability registry. The same control service will serve the desktop graphical interface and future remote clients.

The first release will implement:

* global and per-provider agent-control settings;
* progressive capability discovery;
* recurring, interval, one-time and conditional-prompt automations;
* daemon-owned scheduling and run history;
* pause, resume, update, run-now and delete operations;
* revision-aware updates;
* bounded audit history;
* secret-conscious responses;
* a built-in standard-input/output MCP server;
* automatic exposure to Claude and Codex through FalconDeck’s existing connector materialisation path;
* a basic desktop interface for settings, automations and recent changes.

The implementation must not create a second conversation store or replace FalconDeck’s existing provider execution paths.

---

## 2. Codebase context and constraints

FalconDeck is daemon-first. The daemon owns agent processes, state, protocol translation and durable product behaviour. Desktop, mobile and web applications are clients of that daemon.

The implementation must follow these existing architectural rules:

1. The FalconDeck daemon remains the source of truth.
2. Codex continues to run through `codex app-server`.
3. Claude continues to run through the Claude command-line subprocess path.
4. Agent sessions and conversation history continue to belong to the native agents.
5. Automations invoke agents through FalconDeck’s existing workspace, thread and turn machinery.
6. FalconDeck must not create a separate conversation database.
7. Shared protocol changes begin in `falcondeck-core` and `packages/client-core`.
8. The existing local API’s loopback and browser-origin protection must remain intact.
9. The built-in FalconDeck MCP server must not be represented as user-authored connector configuration.
10. The implementation must preserve the current connector behaviour for user-configured MCP servers.

FalconDeck’s existing connector layer already supports:

* global and workspace connector configuration;
* standard-input/output MCP servers;
* provider-specific filtering;
* Claude `--mcp-config` generation;
* Codex `mcp_servers.*` configuration overrides;
* ACP `session/new` MCP server arrays;
* re-reading connector configuration at provider spawn boundaries.

The agent control implementation should extend this layer rather than build a second provider-specific connector system.

---

## 3. Product principles

### 3.1 Progressive disclosure

The model must not receive a separate tool for every FalconDeck operation.

The three public tools remain stable while the daemon-owned registry may grow to hundreds of internal capabilities.

### 3.2 Stable identifiers

Every operation and durable resource must have a stable explicit identifier.

No operation may depend on hidden protocol-session state.

Examples:

```text
automation.create
automation.update
automation.pause
automation.resume
automation.run_now
automation.delete
agent_control.settings.update
```

### 3.3 One source of behaviour

The graphical interface and MCP adapter call the same control service.

Neither the MCP adapter nor user-interface routes may contain independent automation business logic.

### 3.4 Provider-neutral operations

Capabilities are defined in FalconDeck terms and use the open `AgentProvider` identifier.

The model-facing schema should use `provider`, not a closed Codex/Claude enum and not inconsistent terms such as `harness`.

### 3.5 Safe defaults

Scheduled runs must not silently acquire more filesystem or command authority than the user selected.

Destructive operations must be declared as such.

### 3.6 Durable configuration, bounded operational data

Automation definitions and settings are durable.

Run history, idempotency records and audit entries are bounded.

### 3.7 Explicit execution semantics

Schedules, timezones, missed runs, overlapping runs and conditional behaviour must have deterministic documented behaviour.

---

## 4. Goals

The initial release must:

* allow an agent to discover supported FalconDeck control capabilities;
* allow an agent to create and manage scheduled automations;
* allow the desktop interface to create and manage the same automations;
* expose the same three tools to Claude and Codex;
* store automation definitions in the daemon;
* dispatch automation work through existing FalconDeck threads and turns;
* preserve native provider session ownership;
* support explicit IANA timezones;
* show the next scheduled run and latest outcome;
* survive daemon restarts;
* reject invalid or stale mutations before state changes;
* record the source of mutations;
* avoid returning known secret-bearing fields;
* keep tool output concise and paginated;
* allow the interface to be disabled globally or by provider;
* support modern and initialization-based standard-input/output MCP clients.

---

## 5. Non-goals

The first release will not:

* expose every internal daemon method;
* accept internal HTTP paths or arbitrary method names through `falcondeck_execute`;
* execute arbitrary user-supplied code as a condition;
* replace Codex app-server or the Claude command-line integration;
* create a FalconDeck conversation database;
* guarantee scheduled execution while the FalconDeck daemon is not running;
* provide a cloud scheduling service independent of a user daemon;
* provide team permissions, roles or a new identity system;
* expose connector credentials or environment variable values;
* support remote HTTP transport for the built-in FalconDeck MCP server;
* require the MCP Tasks extension;
* provide full mobile and remote-web automation management in the initial release;
* support dependencies between automations;
* automatically retry failed actions that could have external side effects;
* interpret arbitrary natural-language schedules inside the daemon.

The conversational agent may translate natural language into the structured schedule schema, but the daemon receives and validates structured values.

---

## 6. Terminology

| Term | Meaning |
| -------------------------- | ----------------------------------------------------------------------------------------------- |
| **Control service** | Internal daemon service that owns capability discovery, reads and mutations |
| **Capability registry** | Daemon-owned registry describing supported operations and their schemas |
| **Provider** | Agent provider identifier such as `codex`, `claude` or an ACP provider |
| **Automation** | Durable definition that causes an agent instruction to run on a schedule |
| **Automation run** | One attempted execution of an automation |
| **Managed thread** | Thread created and subsequently reused by FalconDeck for an automation |
| **Control origin** | Source of a control request: MCP, desktop UI, remote RPC, scheduler or system |
| **Revision** | Monotonically increasing version attached to a mutable resource |
| **Misfire** | A scheduled occurrence missed while the daemon was stopped or unavailable |
| **Conditional automation** | A scheduled agent task instructed to return a defined no-action marker when no action is needed |

---

## 7. User stories

### 7.1 Capability discovery

As a user, I can ask:

> What can FalconDeck configure?

The agent can search capabilities without loading every schema into context.

### 7.2 Recurring automation

As a user, I can ask:

> Every weekday at 8am Europe/London time, use Codex in QuizGecko to review my inbox.

The resulting automation includes its resolved schedule, workspace, provider, next run and state.

### 7.3 One-time automation

As a user, I can ask:

> Tomorrow at 10am, remind Claude to review the release checklist in this project.

### 7.4 Conditional automation

As a user, I can ask:

> Every 30 minutes, check for failed production deployments. Do nothing when everything is healthy.

FalconDeck schedules the check. The stored instruction tells the agent to return the configured no-action marker when no intervention is required.

### 7.5 Management

As a user, I can list, inspect, update, pause, resume, run immediately or delete an automation.

### 7.6 Concurrency safety

As a user, an update based on an old version of an automation does not silently overwrite a newer edit.

### 7.7 Disablement

As a user, I can disable FalconDeck conversational control globally or for one provider.

Existing scheduled automations continue to run unless separately paused. Disabling conversational control disables control tools; it does not implicitly disable the scheduler.

### 7.8 Auditability

As a user, I can see recent automation and agent-control changes, including whether they originated from Claude, Codex, the UI, a paired device or the scheduler.

---

## 8. Proposed user experience

### 8.1 Creation through an agent

User:

> Every weekday at 8am, review my inbox and surface anything requiring attention.

Expected model flow:

1. Call `falcondeck_search` with a query such as `create recurring automation`.
2. Receive `automation.create`, its schema, examples and relevant constraints.
3. Identify or ask for materially missing information:

 * workspace;
 * provider;
 * timezone;
 * required connector, if relevant.
4. Call `falcondeck_execute`.
5. Receive a structured automation summary.
6. Explain what was created, including next run and timezone.

The agent must not need to guess an internal route or daemon method.

### 8.2 Management through an agent

User:

> Pause the inbox automation.

Expected flow:

1. Use `falcondeck_get` to identify the automation where necessary.
2. Use the returned `revision`.
3. Call `falcondeck_execute` with `automation.pause`.
4. Return the updated state.

### 8.3 Graphical interface

The desktop interface shows the same automation immediately after an MCP-originated change.

The interface supports:

* listing automations;
* creating and editing an automation;
* pausing and resuming;
* running immediately;
* deleting;
* inspecting run history;
* global and per-provider agent-control toggles;
* recent control changes.

---

## 9. High-level architecture

```text
┌────────────────────────────────────────────────────────────────┐ Agent providers Claude CLI Codex app-server ACP agents └──── FalconDeck built-in MCP connector ─┘ └──────────────────────────────┬─────────────────────────────────┘ stdio
 ▼
┌────────────────────────────────────────────────────────────────┐ falcondeck-daemon mcp - MCP protocol compatibility - tools/list and tools/call - exactly three public tools - no direct state-file access └──────────────────────────────┬─────────────────────────────────┘ loopback control API
 ▼
┌────────────────────────────────────────────────────────────────┐ FalconDeck daemon Control API Control service ── Capability registry ├── Agent-control settings ├── Automation store ├── Scheduler ├── Run history └── Audit history Existing AppState / workspace / thread / turn execution ├── Claude runtime ├── Codex session └── ACP runtimes └──────────────────────────────┬─────────────────────────────────┘ ┌─────────────────┴──────────────────┐
 ▼ ▼
 Desktop graphical UI Future remote clients
```

---

## 10. Recommended module and file layout

The exact split may be adjusted during implementation, but responsibilities should remain separated.

```text
crates/falcondeck-core/src/
 lib.rs
 control.rs
 Shared control request/response types
 Automation wire types
 Agent-control settings
 Control event types

crates/falcondeck-daemon/src/
 control/
 mod.rs
 ControlService public interface
 registry.rs
 Capability definitions and deterministic search
 store.rs
 Persistence, revisions, pagination, audit and migrations
 automations.rs
 Schedule validation, due-time calculation and state transitions
 scheduler.rs
 Background scheduler and provider dispatch
 redaction.rs
 Structured response redaction
 mcp.rs
 MCP stdio server and protocol compatibility

 api.rs
 Add generic control endpoints

 app.rs
 Own ControlService
 Resolve workspaces and dispatch automation turns
 Emit control-state change events

 connectors.rs
 Add built-in FalconDeck connector at materialisation time

 lib.rs
 Start control background task
 Expose control module as needed

 main.rs
 Add `mcp` subcommand

packages/client-core/src/
 control.ts
 TypeScript types
 Control client methods
 Event handling

 daemon-client.ts
 Generic control endpoint calls

apps/desktop/src/components/settings/
 AgentControlPanel.tsx
 Global/provider settings and recent changes

apps/desktop/src/components/
 AutomationsView.tsx
 Automation list, editor and history

docs/
 AGENT-CONTROL.md
 User and implementation documentation
```

The core crate does not need to contain scheduler implementation details. It should contain only shared serialisable types that cross daemon/client boundaries.

---

## 11. Domain model

The following Rust is illustrative of the intended wire and storage model.

### 11.1 Agent-control settings

```rust
use std::collections::BTreeMap;

use falcondeck_core::AgentProvider;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AgentControlSettings {
 /// Controls whether MCP-originated FalconDeck control is accepted.
 pub enabled: bool,

 /// Provider-specific overrides. Missing providers inherit `enabled`.
 #[serde(default)]
 pub providers: BTreeMap<AgentProvider, ProviderControlSettings>,

 /// Default timezone offered when creating recurring schedules.
 pub default_timezone: String,

 /// Whether creation of automations using elevated permission modes is allowed.
 pub allow_elevated_automations: bool,

 /// Client-facing confirmation preferences.
 pub confirmation_policy: ConfirmationPolicy,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProviderControlSettings {
 pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ConfirmationPolicy {
 pub destructive_operations: bool,
 pub sensitive_operations: bool,
}

impl Default for AgentControlSettings {
 fn default() -> Self {
 Self {
 enabled: true,
 providers: BTreeMap::new(),
 default_timezone: "Europe/London".to_string(),
 allow_elevated_automations: false,
 confirmation_policy: ConfirmationPolicy {
 destructive_operations: true,
 sensitive_operations: true,
 },
 }
 }
}
```

The product default timezone should be detected by the UI or daemon using an IANA timezone source. It must not silently use a fixed UTC offset such as `+01:00`.

### 11.2 Automation definition

```rust
use chrono::{DateTime, Utc};
use falcondeck_core::AgentProvider;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Automation {
 pub id: String,
 pub revision: u64,

 pub name: String,
 pub description: Option<String>,

 pub trigger: AutomationTrigger,
 pub task: AutomationTask,
 pub target: AutomationTarget,

 pub state: AutomationState,
 pub concurrency_policy: AutomationConcurrencyPolicy,
 pub misfire_policy: AutomationMisfirePolicy,

 #[serde(default)]
 pub required_connectors: Vec<String>,

 pub created_at: DateTime<Utc>,
 pub updated_at: DateTime<Utc>,

 pub next_run_at: Option<DateTime<Utc>>,
 pub last_run_at: Option<DateTime<Utc>>,
 pub latest_outcome: Option<AutomationOutcomeSummary>,
}
```

### 11.3 Trigger types

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AutomationTrigger {
 /// Absolute instant. The supplied RFC 3339 value must include an offset.
 Once {
 run_at: DateTime<Utc>,
 },

 /// Five-field cron expression evaluated in an IANA timezone.
 Cron {
 expression: String,
 timezone: String,
 },

 /// Fixed elapsed interval. Suitable for polling-style checks.
 Interval {
 every_seconds: u64,
 anchor_at: DateTime<Utc>,
 },
}
```

Version one cron expressions use exactly five fields:

```text
minute hour day-of-month month day-of-week
```

Examples:

```text
0 8 * * 1-5 Every weekday at 08:00
30 9 * * * Every day at 09:30
0 18 * * 0 Every Sunday at 18:00
```

The daemon must reject six-field expressions rather than guessing whether the first field means seconds.

### 11.4 Task types

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AutomationTask {
 Prompt {
 instruction: String,
 },

 /// The same scheduled agent execution path is used, but a precise marker
 /// lets FalconDeck classify the run as requiring no action.
 ConditionalPrompt {
 instruction: String,
 no_action_marker: String,
 },
}
```

A conditional instruction should normally include language such as:

```text
Check whether any production deployment has failed since the previous run.

If nothing requires attention, reply with exactly:
FALCONDECK_NO_ACTION

Otherwise investigate the failure and provide a concise summary with the
affected service, timestamp and recommended next action.
```

Version one does not execute a separate arbitrary predicate.

### 11.5 Durable target

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AutomationTarget {
 /// Durable canonical path, not the runtime-generated workspace id.
 pub workspace_path: String,

 pub provider: AgentProvider,

 pub thread: AutomationThreadTarget,

 /// Optional current-provider-default model resolution.
 pub model_id: Option<String>,

 /// Explicit authority settings captured by the automation.
 pub permission_mode: Option<String>,
 pub sandbox_mode: Option<String>,

 #[serde(default)]
 pub selected_skills: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AutomationThreadTarget {
 /// Default. FalconDeck creates a dedicated thread and remembers its id.
 Managed {
 thread_id: Option<String>,
 },

 /// Run in a user-selected existing thread.
 Existing {
 thread_id: String,
 },

 /// Create a clean native thread for every execution.
 NewEachRun,
}
```

`workspace_path` must be canonicalised through the same normalisation used by the existing workspace restoration code.

A runtime `workspace_id` may appear in an individual run record, but it must never be the sole durable locator in an automation definition.

### 11.6 States and policies

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutomationState {
 Enabled,
 Paused,
 Completed,
 Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutomationConcurrencyPolicy {
 /// Default: do not overlap runs.
 Skip,

 /// Keep at most one additional due occurrence.
 QueueOne,

 /// Allow overlapping runs, subject to the daemon-wide limit.
 Allow,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutomationMisfirePolicy {
 /// Default: do not replay occurrences missed while FalconDeck was stopped.
 Skip,

 /// Execute at most one missed occurrence after restart.
 RunOnce,
}
```

### 11.7 Run record

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AutomationRun {
 pub id: String,
 pub automation_id: String,

 /// Snapshot for useful history after the definition changes.
 pub automation_name: String,
 pub automation_revision: u64,

 pub status: AutomationRunStatus,
 pub scheduled_for: Option<DateTime<Utc>>,

 pub queued_at: DateTime<Utc>,
 pub started_at: Option<DateTime<Utc>>,
 pub finished_at: Option<DateTime<Utc>>,

 pub runtime_workspace_id: Option<String>,
 pub thread_id: Option<String>,
 pub turn_id: Option<String>,

 pub outcome_preview: Option<String>,
 pub error: Option<ControlErrorDetail>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AutomationRunStatus {
 Queued,
 Running,
 Succeeded,
 SucceededNoAction,
 Failed,
 SkippedOverlap,
 SkippedDependency,
 Cancelled,
}
```

Run history stores a bounded preview, not the complete provider transcript.

The authoritative full response remains in the native agent thread.

---

## 12. Persistence

### 12.1 Storage location

Initial implementation should use a dedicated daemon-owned file adjacent to the existing daemon state file:

```text
~/.falcondeck/agent-control.json
```

Remote or headless daemons use their own state directory.

The control store must not be embedded into `connectors.json`.

### 12.2 Stored shape

```json
{
 "schema_version": 1,
 "store_revision": 42,
 "settings": {
 "enabled": true,
 "providers": {
 "claude": { "enabled": true },
 "codex": { "enabled": true }
 },
 "default_timezone": "Europe/London",
 "allow_elevated_automations": false,
 "confirmation_policy": {
 "destructive_operations": true,
 "sensitive_operations": true
 }
 },
 "automations": [],
 "runs": [],
 "audit": [],
 "idempotency_records": []
}
```

### 12.3 Atomic writes

Writes must follow the established safe-file pattern:

1. Serialise the complete next state.
2. Write a uniquely named temporary file in the same directory.
3. Use restrictive permissions on Unix.
4. Flush the file.
5. Rename over the previous file.

Illustrative helper:

```rust
fn write_control_state(path: &Path, state: &PersistedControlState) -> Result<(), String> {
 let parent = path.parent().ok_or("control state path has no parent")?;
 std::fs::create_dir_all(parent)
 .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;

 let body = serde_json::to_vec_pretty(state)
 .map_err(|error| format!("failed to encode control state: {error}"))?;

 let temp = path.with_extension(format!(
 "json.tmp.{}",
 uuid::Uuid::new_v4().simple()
 ));

 let mut options = std::fs::OpenOptions::new();
 options.create_new(true).write(true);

 #[cfg(unix)]
 {
 use std::os::unix::fs::OpenOptionsExt;
 options.mode(0o600);
 }

 let mut file = options
 .open(&temp)
 .map_err(|error| format!("failed to open {}: {error}", temp.display()))?;

 use std::io::Write;
 file.write_all(&body)
 .and_then(|_| file.sync_all())
 .map_err(|error| format!("failed to write {}: {error}", temp.display()))?;

 std::fs::rename(&temp, path)
 .map_err(|error| format!("failed to replace {}: {error}", path.display()))
}
```

### 12.4 Bounds

Initial defaults:

| Data | Retention |
| -------------------------- | --------------------------------------------: |
| Run records per automation | 100 |
| Total run records | 1,000 |
| Audit entries | 500 |
| Idempotency records | 128 or 24 hours, whichever removes them first |
| Outcome preview | 1,000 UTF-8 characters |
| Error message | 2,000 UTF-8 characters |

Compaction occurs during mutations and after run completion.

### 12.5 Migration

The file includes `schema_version`.

Unknown future versions must fail safely with a clear error and must not overwrite the file.

A missing file produces default settings and an empty automation list.

A malformed file should:

* be preserved;
* be renamed or copied to a timestamped recovery file;
* cause automation scheduling to remain disabled until the user resolves the problem;
* surface a visible daemon service warning.

---

## 13. Control request context and audit

### 13.1 Request context

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ControlRequestContext {
 pub origin: ControlOrigin,
 pub provider: Option<AgentProvider>,
 pub workspace_path: Option<String>,
 pub thread_id: Option<String>,
 pub device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ControlOrigin {
 DesktopUi,
 Mcp,
 RemoteRpc,
 Scheduler,
 System,
}
```

For Claude, FalconDeck can generally provide provider, workspace and current thread context at the turn spawn boundary.

For a long-lived Codex app-server MCP configuration, provider and workspace context are required; thread context is best-effort and may be absent.

Audit context is informational, not a separate security identity.

### 13.2 Audit entry

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ControlAuditEntry {
 pub id: String,
 pub occurred_at: DateTime<Utc>,
 pub context: ControlRequestContext,

 pub operation: String,
 pub resource_type: Option<String>,
 pub resource_id: Option<String>,

 pub result: AuditResult,

 /// Redacted summary only; never the full automation instruction.
 pub summary: String,
}
```

Every mutation must produce an audit entry whether it succeeds or fails after validation begins.

Read operations do not need audit entries in version one.

---

## 14. Capability registry

### 14.1 Capability definition

The registry is authoritative for:

* stable operation ID;
* display title;
* description;
* domain;
* supported scopes;
* input schema;
* output schema;
* defaults and constraints;
* behavioural metadata;
* examples;
* related operations.

Illustrative Rust:

```rust
use serde_json::Value;

#[derive(Debug, Clone)]
pub struct Capability {
 pub id: &'static str,
 pub title: &'static str,
 pub description: &'static str,
 pub domain: &'static str,
 pub scopes: &'static [ControlScope],

 pub input_schema: Value,
 pub output_schema: Value,

 pub behavior: CapabilityBehavior,
 pub examples: &'static [CapabilityExample],
 pub related_operations: &'static [&'static str],
}

#[derive(Debug, Clone, Copy)]
pub struct CapabilityBehavior {
 pub read_only: bool,
 pub destructive: bool,
 pub idempotent: bool,
 pub confirmation_class: ConfirmationClass,
}

#[derive(Debug, Clone, Copy)]
pub enum ConfirmationClass {
 None,
 Mutation,
 Sensitive,
 Destructive,
}
```

### 14.2 Schema generation

Schemas should be generated from typed request and response structures where practical.

Recommended approach:

```rust
use schemars::{JsonSchema, schema_for};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateAutomationArgs {
 pub name: String,
 pub trigger: AutomationTrigger,
 pub task: AutomationTask,
 pub target: AutomationTarget,

 #[serde(default)]
 pub required_connectors: Vec<String>,

 #[serde(default)]
 pub concurrency_policy: AutomationConcurrencyPolicy,

 #[serde(default)]
 pub misfire_policy: AutomationMisfirePolicy,
}

fn create_automation_capability() -> Capability {
 Capability {
 id: "automation.create",
 title: "Create automation",
 description: "Create a recurring, interval, one-time, or conditional-prompt automation.",
 domain: "automation",
 scopes: &[ControlScope::Host, ControlScope::Workspace],
 input_schema: serde_json::to_value(schema_for!(CreateAutomationArgs))
 .expect("static schema serializes"),
 output_schema: serde_json::to_value(schema_for!(Automation))
 .expect("static schema serializes"),
 behavior: CapabilityBehavior {
 read_only: false,
 destructive: false,
 idempotent: false,
 confirmation_class: ConfirmationClass::Mutation,
 },
 examples: CREATE_AUTOMATION_EXAMPLES,
 related_operations: &[
 "automation.update",
 "automation.pause",
 "automation.run_now",
 ],
 }
}
```

Request structures should use `#[serde(deny_unknown_fields)]` so misspelled fields are rejected instead of ignored.

### 14.3 Initial operation registry

| Operation | Behaviour |
| ------------------------------- | -------------------------------------- |
| `agent_control.settings.update` | Mutation |
| `automation.create` | Mutation |
| `automation.update` | Mutation, revision required |
| `automation.pause` | Idempotent mutation, revision required |
| `automation.resume` | Idempotent mutation, revision required |
| `automation.run_now` | Mutation, idempotency key supported |
| `automation.delete` | Destructive, revision required |

Reads are handled through `falcondeck_get` rather than separate execute operations.

### 14.4 Search behaviour

Capability search must be deterministic and local.

It does not require embeddings or another language-model call.

Search scoring should consider:

1. exact operation ID;
2. exact domain;
3. title tokens;
4. description tokens;
5. example text;
6. related operation IDs.

Default response returns compact summaries.

An exact operation ID or `detail: "full"` returns the complete schema.

---

## 15. Internal control service

The service should expose three conceptual methods independent of transport:

```rust
impl ControlService {
 pub async fn search(
 &self,
 request: ControlSearchRequest,
 context: &ControlRequestContext,
 ) -> Result<ControlSearchResponse, ControlError>;

 pub async fn get(
 &self,
 request: ControlGetRequest,
 context: &ControlRequestContext,
 ) -> Result<ControlGetResponse, ControlError>;

 pub async fn execute(
 &self,
 request: ControlExecuteRequest,
 context: &ControlRequestContext,
 app: &AppState,
 ) -> Result<ControlExecuteResponse, ControlError>;
}
```

The MCP adapter and graphical interface do not call store methods directly.

### 15.1 Search request

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlSearchRequest {
 pub query: Option<String>,
 pub domain: Option<String>,
 pub operation: Option<String>,

 #[serde(default)]
 pub detail: SearchDetail,

 #[serde(default = "default_search_limit")]
 pub limit: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SearchDetail {
 #[default]
 Summary,
 Full,
}
```

### 15.2 Get request

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlGetRequest {
 pub resource: String,
 pub id: Option<String>,

 #[serde(default)]
 pub filters: serde_json::Map<String, serde_json::Value>,

 #[serde(default)]
 pub fields: Vec<String>,

 pub cursor: Option<String>,

 #[serde(default = "default_page_limit")]
 pub limit: usize,
}
```

Initial resources:

```text
agent_control.settings
automations
automation
automation.runs
control.audit
```

### 15.3 Execute request

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ControlExecuteRequest {
 pub operation: String,

 #[serde(default)]
 pub arguments: serde_json::Map<String, serde_json::Value>,

 pub expected_revision: Option<u64>,
 pub idempotency_key: Option<String>,
}
```

The daemon must not accept:

```json
{
 "operation": "/api/internal/delete-everything"
}
```

Only operation identifiers registered in the capability registry are executable.

---

## 16. Generic local control API

Add three local API routes:

```rust
Router::new()
 // Existing routes...
 .route("/api/control/search", post(control_search))
 .route("/api/control/get", post(control_get))
 .route("/api/control/execute", post(control_execute))
```

Illustrative handlers:

```rust
async fn control_search(
 State(state): State<AppState>,
 headers: HeaderMap,
 Json(request): Json<ControlSearchRequest>,
) -> Result<Json<ControlSearchResponse>, DaemonError> {
 let context = control_context_from_headers(&headers, ControlOrigin::DesktopUi)?;
 Ok(Json(state.control_search(request, context).await?))
}

async fn control_execute(
 State(state): State<AppState>,
 headers: HeaderMap,
 Json(request): Json<ControlExecuteRequest>,
) -> Result<Json<ControlExecuteResponse>, DaemonError> {
 let context = control_context_from_headers(&headers, ControlOrigin::DesktopUi)?;
 Ok(Json(state.control_execute(request, context).await?))
}
```

The MCP subprocess adds an internal header that causes the route to construct `ControlOrigin::Mcp` and populate provider/workspace context.

The model does not supply or override this context inside tool arguments.

Example internal headers:

```text
X-FalconDeck-Control-Origin: mcp
X-FalconDeck-Control-Provider: codex
X-FalconDeck-Control-Workspace: /Users/james/Code/quizgecko
X-FalconDeck-Control-Thread: optional-thread-id
```

These headers are for context and enforcement inside the loopback trust model. They are not exposed as part of the public MCP schema.

---

## 17. Public MCP interface

The server exposes exactly three tools.

### 17.1 `falcondeck_search`

Purpose:

* discover capabilities;
* retrieve operation IDs;
* retrieve schemas and examples;
* understand constraints and related operations.

Input schema:

```json
{
 "$schema": "https://json-schema.org/draft/2020-12/schema",
 "type": "object",
 "additionalProperties": false,
 "properties": {
 "query": {
 "type": "string",
 "description": "Natural-language capability search."
 },
 "domain": {
 "type": "string",
 "description": "Optional domain such as automation or agent_control."
 },
 "operation": {
 "type": "string",
 "description": "Exact stable operation identifier."
 },
 "detail": {
 "type": "string",
 "enum": ["summary", "full"],
 "default": "summary"
 },
 "limit": {
 "type": "integer",
 "minimum": 1,
 "maximum": 20,
 "default": 8
 }
 }
}
```

Example call:

```json
{
 "query": "create a recurring scheduled task",
 "domain": "automation",
 "detail": "full",
 "limit": 5
}
```

Example result:

```json
{
 "results": [
 {
 "operation": "automation.create",
 "title": "Create automation",
 "description": "Create a recurring, interval, one-time, or conditional-prompt automation.",
 "domain": "automation",
 "behavior": {
 "read_only": false,
 "destructive": false,
 "idempotent": false,
 "confirmation_class": "mutation"
 },
 "input_schema": {
 "type": "object",
 "properties": {}
 },
 "related_operations": [
 "automation.update",
 "automation.pause",
 "automation.run_now"
 ],
 "available": true
 }
 ]
}
```

### 17.2 `falcondeck_get`

Purpose:

* read settings;
* list resources;
* inspect one resource;
* retrieve run and audit history;
* select fields;
* paginate.

Input schema:

```json
{
 "$schema": "https://json-schema.org/draft/2020-12/schema",
 "type": "object",
 "additionalProperties": false,
 "required": ["resource"],
 "properties": {
 "resource": {
 "type": "string",
 "enum": [
 "agent_control.settings",
 "automations",
 "automation",
 "automation.runs",
 "control.audit"
 ]
 },
 "id": {
 "type": "string"
 },
 "filters": {
 "type": "object",
 "default": {}
 },
 "fields": {
 "type": "array",
 "items": { "type": "string" },
 "maxItems": 32,
 "default": []
 },
 "cursor": {
 "type": "string"
 },
 "limit": {
 "type": "integer",
 "minimum": 1,
 "maximum": 100,
 "default": 20
 }
 }
}
```

Example:

```json
{
 "resource": "automations",
 "filters": {
 "state": ["enabled", "paused"]
 },
 "fields": [
 "id",
 "revision",
 "name",
 "state",
 "next_run_at",
 "latest_outcome"
 ],
 "limit": 20
}
```

### 17.3 `falcondeck_execute`

Purpose:

* execute one registered operation;
* validate arguments against the current operation schema;
* enforce revisions and settings;
* return a structured concise result.

Input schema:

```json
{
 "$schema": "https://json-schema.org/draft/2020-12/schema",
 "type": "object",
 "additionalProperties": false,
 "required": ["operation", "arguments"],
 "properties": {
 "operation": {
 "type": "string",
 "description": "Stable operation identifier returned by falcondeck_search."
 },
 "arguments": {
 "type": "object"
 },
 "expected_revision": {
 "type": "integer",
 "minimum": 1
 },
 "idempotency_key": {
 "type": "string",
 "minLength": 8,
 "maxLength": 128
 }
 }
}
```

Example creation:

```json
{
 "operation": "automation.create",
 "idempotency_key": "inbox-weekday-8am-2026-08-16",
 "arguments": {
 "name": "Weekday inbox review",
 "trigger": {
 "kind": "cron",
 "expression": "0 8 * * 1-5",
 "timezone": "Europe/London"
 },
 "task": {
 "kind": "conditional_prompt",
 "instruction": "Review my inbox. Surface messages that need my attention. If nothing requires attention, reply exactly FALCONDECK_NO_ACTION.",
 "no_action_marker": "FALCONDECK_NO_ACTION"
 },
 "target": {
 "workspace_path": "/Users/james/Code/quizgecko",
 "provider": "codex",
 "thread": {
 "kind": "managed",
 "thread_id": null
 },
 "model_id": null,
 "permission_mode": null,
 "sandbox_mode": "workspace-write",
 "selected_skills": []
 },
 "required_connectors": ["gmail"],
 "concurrency_policy": "skip",
 "misfire_policy": "skip"
 }
}
```

Example response:

```json
{
 "ok": true,
 "operation": "automation.create",
 "data": {
 "id": "automation-9fc78b39",
 "revision": 1,
 "name": "Weekday inbox review",
 "state": "enabled",
 "next_run_at": "2026-08-17T07:00:00Z",
 "resolved_schedule": "Weekdays at 08:00 Europe/London",
 "target": {
 "workspace_path": "/Users/james/Code/quizgecko",
 "provider": "codex",
 "thread": {
 "kind": "managed",
 "thread_id": null
 }
 }
 }
}
```

---

## 18. MCP protocol implementation

### 18.1 Standard-input/output transport

The built-in MCP server runs as a subprocess:

```text
falcondeck-daemon mcp
```

It reads one JSON-RPC message per line from standard input and writes only valid MCP messages to standard output.

All diagnostics go to standard error.

### 18.2 Supported protocol flows

Modern flow:

```text
server/discover optional
tools/list
tools/call
```

Compatibility flow:

```text
initialize
notifications/initialized
tools/list
tools/call
```

Also support:

```text
ping
notifications/cancelled
```

The implementation does not need resources, prompts, sampling, roots or logging protocol features.

### 18.3 Dispatcher sketch

```rust
async fn handle_message(
 message: JsonRpcMessage,
 client: &ControlApiClient,
 compatibility: &mut CompatibilityState,
) -> Option<JsonRpcResponse> {
 let request = message.into_request()?;

 match request.method.as_str() {
 "server/discover" => Some(discover_response(request.id)),

 "initialize" => {
 compatibility.legacy_initialized = true;
 Some(legacy_initialize_response(request.id))
 }

 "notifications/initialized" => None,

 "ping" => Some(success(request.id, serde_json::json!({}))),

 "tools/list" => Some(tools_list_response(
 request.id,
 compatibility.protocol_mode(),
 )),

 "tools/call" => Some(
 handle_tool_call(request.id, request.params, client)
 .await
 .unwrap_or_else(|error| tool_error_response(request.id, error))
 ),

 _ => Some(method_not_found(request.id, request.method)),
 }
}
```

### 18.4 Tool ordering and cacheability

`tools/list` must return tools in this fixed order:

```text
falcondeck_search
falcondeck_get
falcondeck_execute
```

For protocol versions that support cache hints, the result should be private and long-lived because the top-level three-tool catalogue rarely changes:

```json
{
 "tools": [],
 "ttlMs": 3600000,
 "cacheScope": "private"
}
```

Capability details remain dynamically discoverable through `falcondeck_search`.

### 18.5 Structured tool results

Successful tool calls should return both:

* `structuredContent`, for clients supporting structured output;
* serialised JSON text content, for compatibility.

Example:

```json
{
 "content": [
 {
 "type": "text",
 "text": "{\"ok\":true,\"data\":{\"id\":\"automation-9fc78b39\"}}"
 }
 ],
 "structuredContent": {
 "ok": true,
 "data": {
 "id": "automation-9fc78b39"
 }
 },
 "isError": false
}
```

Validation and operation failures should generally be tool errors with `isError: true`, not transport-level JSON-RPC failures.

Malformed JSON-RPC, unknown MCP methods and unknown public tool names remain protocol-level errors.

### 18.6 Generic execute annotation limitation

The top-level `falcondeck_execute` tool can perform operations with different risk profiles.

Its MCP annotation must therefore be conservative. Fine-grained behaviour is returned in the capability metadata from `falcondeck_search`.

Suggested top-level annotations:

```json
{
 "readOnlyHint": false,
 "destructiveHint": true,
 "idempotentHint": false,
 "openWorldHint": false
}
```

---

## 19. MCP subprocess configuration

The subprocess receives daemon and origin context through arguments or environment variables.

Example:

```text
FALCONDECK_DAEMON_URL=http://127.0.0.1:4520
FALCONDECK_CONTROL_PROVIDER=codex
FALCONDECK_CONTROL_WORKSPACE=/Users/james/Code/quizgecko
FALCONDECK_CONTROL_THREAD=
```

The MCP process:

* does not open or mutate `agent-control.json`;
* does not instantiate its own scheduler;
* does not execute providers directly;
* communicates with the running daemon’s control API;
* exits if the daemon cannot be reached;
* writes connection failures to standard error and returns concise tool errors.

---

## 20. Built-in connector integration

### 20.1 Behaviour

FalconDeck’s connector materialisation should combine:

1. user-authored global connectors;
2. user-authored workspace connectors;
3. the built-in FalconDeck control connector, when enabled.

The built-in connector is generated in memory.

It must not be written into:

```text
~/.falcondeck/connectors.json
<workspace>/.falcondeck/connectors.json
```

### 20.2 Reserved connector identity

Reserve the system connector name:

```text
falcondeck
```

A user connector with the same name should be ignored with a clear warning rather than overriding the built-in server.

### 20.3 Configuration example

```rust
fn builtin_control_server(
 daemon_executable: &Path,
 daemon_url: &str,
 provider: &AgentProvider,
 workspace_path: &str,
 thread_id: Option<&str>,
) -> McpServerConfig {
 let mut env = BTreeMap::from([
 (
 "FALCONDECK_DAEMON_URL".to_string(),
 daemon_url.to_string(),
 ),
 (
 "FALCONDECK_CONTROL_PROVIDER".to_string(),
 provider.to_string(),
 ),
 (
 "FALCONDECK_CONTROL_WORKSPACE".to_string(),
 workspace_path.to_string(),
 ),
 ]);

 if let Some(thread_id) = thread_id {
 env.insert(
 "FALCONDECK_CONTROL_THREAD".to_string(),
 thread_id.to_string(),
 );
 }

 McpServerConfig {
 name: "falcondeck".to_string(),
 transport: McpTransport::Stdio {
 command: daemon_executable.display().to_string(),
 args: vec!["mcp".to_string()],
 env,
 },
 }
}
```

### 20.4 Provider application timing

Claude:

* connector inclusion is evaluated at each turn spawn;
* setting changes apply on the next turn.

Codex:

* connector inclusion is evaluated when the app-server process starts;
* a disablement change must immediately cause the control service to reject MCP-originated requests;
* catalogue removal may occur when the Codex runtime next restarts;
* FalconDeck may restart an idle runtime to apply the change sooner;
* a running turn must not be terminated solely to refresh its connector catalogue.

ACP:

* pass the same standard-input/output connector in `session/new`;
* ACP is architecture-ready but not required for initial acceptance.

---

## 21. Enablement and enforcement

### 21.1 Global setting

When global control is disabled:

* no newly spawned provider receives the FalconDeck connector;
* MCP-originated control API requests are rejected;
* desktop UI control remains available;
* scheduled automations continue to run;
* the scheduler remains active.

### 21.2 Per-provider setting

When a provider is disabled:

* that provider no longer receives the built-in connector on future spawn;
* any stale MCP process for that provider receives an `interface_disabled` error;
* other providers remain unaffected.

### 21.3 Server-side enforcement

Tool removal alone is insufficient because a provider process may have cached the tool.

Every MCP-originated control request must pass:

```rust
fn ensure_mcp_enabled(
 settings: &AgentControlSettings,
 provider: Option<&AgentProvider>,
) -> Result<(), ControlError> {
 if !settings.enabled {
 return Err(ControlError::interface_disabled(
 "FalconDeck agent control is disabled globally.",
 ));
 }

 if let Some(provider) = provider {
 if settings
 .providers
 .get(provider)
 .is_some_and(|settings| !settings.enabled)
 {
 return Err(ControlError::interface_disabled(format!(
 "FalconDeck agent control is disabled for provider {provider}."
 )));
 }
 }

 Ok(())
}
```

---

## 22. Validation rules

### 22.1 General

* Automation name: 1–120 characters.
* Description: maximum 2,000 characters.
* Instruction: 1–32,000 characters.
* No-action marker: 1–100 characters, single line.
* Required connector names: unique, maximum 32.
* Unknown fields are rejected.
* Workspace path must be absolute after normalisation.
* Provider identifier must be configured or discoverable.
* Page limit defaults to 20 and may not exceed 100.
* Capability search limit may not exceed 20.

### 22.2 Scheduling

* One-time date must be in the future when created.
* Cron expressions use five fields.
* Cron timezone must be a valid IANA identifier.
* Interval minimum: 60 seconds.
* Cron schedules more frequent than once per minute are impossible under the five-field format.
* The daemon calculates and returns the next occurrence during validation.
* An automation with no calculable next occurrence is rejected.

### 22.3 Permissions

Automations may not silently use an elevated mode.

Examples considered elevated:

```text
Claude: bypassPermissions
Codex: danger-full-access
```

Creating or updating such an automation requires:

```text
settings.allow_elevated_automations == true
```

The response and graphical interface must clearly show the elevated mode.

### 22.4 Connectors

When `required_connectors` are supplied:

* validate that each named connector is available to the target provider and workspace;
* reject creation when a required connector is absent or disabled;
* re-check at execution time;
* record `skipped_dependency` if it later becomes unavailable.

The daemon does not attempt to infer required connectors from arbitrary prompt text.

---

## 23. Schedule semantics

### 23.1 Timezones

Cron schedules use IANA timezone names.

Store:

```json
{
 "expression": "0 8 * * 1-5",
 "timezone": "Europe/London"
}
```

Do not store only:

```json
{
 "utc_offset": "+01:00"
}
```

The next UTC execution time changes correctly when daylight-saving rules change.

### 23.2 Ambiguous local times

For a local wall-clock time that occurs twice during a backward clock change:

* execute at most once;
* choose the earlier resolved instant;
* persist the occurrence key so it cannot be dispatched twice.

### 23.3 Nonexistent local times

For a local wall-clock time skipped during a forward clock change:

* do not invent a different wall-clock time;
* skip that occurrence;
* calculate the next valid occurrence.

### 23.4 Misfires

On daemon restoration:

* `skip`: calculate the next future occurrence and do not replay missed runs;
* `run_once`: execute one missed occurrence if one or more were missed, then continue normally;
* never enqueue every occurrence missed over a long offline period.

### 23.5 One-time automations

After a successful or failed execution attempt, a one-time automation transitions to `completed`.

It is retained for inspection until deleted.

### 23.6 Concurrency

Default policy is `skip`.

When a due time occurs while the automation is already running:

* `skip`: create a `skipped_overlap` run record;
* `queue_one`: preserve at most one pending occurrence;
* `allow`: dispatch subject to the global automation concurrency limit.

Initial global concurrency limit:

```text
4 active automation runs per daemon
```

### 23.7 Retries

Version one performs no automatic action-level retries.

A transient provider-start failure is recorded as failed. The user may invoke `automation.run_now`.

This avoids accidental duplicate email sends, deployments, purchases or external mutations.

---

## 24. Scheduler

### 24.1 Lifecycle

The scheduler is a daemon background task.

It starts only after control state has been loaded.

It wakes when:

* the next due instant arrives;
* an automation definition changes;
* an automation is paused or resumed;
* a run finishes;
* control state is restored.

### 24.2 Suggested structure

```rust
pub async fn run_automation_background(state: AppState) {
 let mut events = state.subscribe();

 loop {
 let next_due = state.control().next_due_at().await;
 let sleep = sleep_until_optional(next_due);

 tokio::select! {
 _ = state.control().scheduler_notify().notified() => {
 // Recalculate next due time.
 }

 _ = sleep => {
 if let Err(error) = dispatch_due_automations(&state).await {
 tracing::warn!(%error, "failed to dispatch due automations");
 }
 }

 event = events.recv() => {
 match event {
 Ok(event) => {
 if let Err(error) =
 state.control().observe_daemon_event(&event).await
 {
 tracing::warn!(
 %error,
 "failed to update automation run from daemon event"
 );
 }
 }

 Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
 state.control().reconcile_active_runs(&state).await;
 }

 Err(tokio::sync::broadcast::error::RecvError::Closed) => {
 break;
 }
 }
 }
 }
 }
}
```

### 24.3 No polling every second

The scheduler should sleep until the nearest due time and use `Notify` for definition changes.

A bounded reconciliation interval may still run every few minutes as defensive recovery.

---

## 25. Execution through existing agent machinery

### 25.1 Workspace resolution

At execution time:

1. Canonicalise the stored workspace path.
2. Find the currently connected workspace with the same canonical path.
3. If absent, attempt the existing `connect_workspace` flow.
4. If the path no longer exists or cannot be connected, fail the run clearly.
5. Store the runtime workspace ID only in the run record.

### 25.2 Thread resolution

For `managed`:

1. Reuse the stored thread ID when it still exists.
2. If missing, create a new native thread using existing `start_thread`.
3. Persist the newly assigned thread ID back into the automation with an internal revision increment.

For `existing`:

* fail if the selected thread cannot be found or resumed.

For `new_each_run`:

* create a new native thread for every run.

### 25.3 Turn dispatch

The implementation should add an internal automation-specific wrapper rather than duplicating provider logic:

```rust
pub struct AutomationDispatch {
 pub workspace_id: String,
 pub thread_id: String,
 pub turn_id: Option<String>,
}

impl AppState {
 pub(crate) async fn dispatch_automation_turn(
 &self,
 run_id: &str,
 automation: &Automation,
 ) -> Result<AutomationDispatch, DaemonError> {
 let workspace = self
 .resolve_or_connect_workspace_path(&automation.target.workspace_path)
 .await?;

 let thread = self
 .resolve_automation_thread(&workspace.id, automation)
 .await?;

 let instruction = match &automation.task {
 AutomationTask::Prompt { instruction } => instruction.clone(),
 AutomationTask::ConditionalPrompt { instruction, .. } => instruction.clone(),
 };

 let response = self
 .send_turn(SendTurnRequest {
 workspace_id: workspace.id.clone(),
 thread_id: thread.id.clone(),
 inputs: vec![TurnInputItem::Text {
 id: None,
 text: instruction,
 }],
 selected_skills: automation
 .target
 .selected_skills
 .iter()
 .map(|skill_id| SelectedSkillReference {
 skill_id: skill_id.clone(),
 alias: format!("/{skill_id}"),
 })
 .collect(),
 provider: Some(automation.target.provider.clone()),
 model_id: automation.target.model_id.clone(),
 reasoning_effort: None,
 approval_policy: None,
 service_tier: None,
 permission_mode: automation.target.permission_mode.clone(),
 sandbox_mode: automation.target.sandbox_mode.clone(),
 steer: false,
 })
 .await?;

 Ok(AutomationDispatch {
 workspace_id: workspace.id,
 thread_id: thread.id,
 turn_id: response.turn_id,
 })
 }
}
```

The exact return type may differ from the existing `send_turn` API. If the public response does not expose a turn ID, introduce an internal helper that can obtain it without breaking existing client contracts.

### 25.4 Completion tracking

The automation service observes existing normalized turn events.

A run finishes when the corresponding turn reaches a terminal state.

For a conditional task:

* inspect the final assistant text;
* trim whitespace;
* compare exactly with `no_action_marker`;
* mark `succeeded_no_action` when it matches;
* otherwise mark `succeeded`.

The run stores only a bounded preview and thread reference.

---

## 26. Revision-aware concurrency

Every automation begins at revision `1`.

Every definition mutation increments its revision.

Mutation example:

```rust
fn require_revision(
 automation: &Automation,
 expected: Option<u64>,
) -> Result<(), ControlError> {
 let expected = expected.ok_or_else(|| {
 ControlError::validation(
 "expected_revision is required for this operation",
 Some("Read the current automation and retry with its revision."),
 )
 })?;

 if expected != automation.revision {
 return Err(ControlError::revision_conflict(
 expected,
 automation.revision,
 ));
 }

 Ok(())
}
```

Conflict response:

```json
{
 "ok": false,
 "error": {
 "code": "revision_conflict",
 "message": "Automation automation-9fc78b39 changed after it was read.",
 "retryable": true,
 "current_revision": 4,
 "suggested_action": "Read the automation again, reconcile the changes and retry with expected_revision 4."
 }
}
```

`run_now` does not require the automation revision because it does not alter the definition.

`delete`, `update`, `pause` and `resume` require it.

---

## 27. Idempotency

`falcondeck_execute` accepts an optional idempotency key.

It is particularly useful for:

* `automation.create`;
* `automation.run_now`.

The key is scoped to:

```text
control origin + provider + operation + idempotency key
```

When the same key and semantically identical arguments are received again within the retention window, return the original result.

If the same key is reused with different arguments, return `idempotency_conflict`.

---

## 28. Error model

### 28.1 Structured error

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ControlErrorDetail {
 pub code: String,
 pub message: String,

 pub retryable: bool,

 #[serde(default)]
 pub field_errors: Vec<FieldError>,

 pub current_revision: Option<u64>,
 pub suggested_action: Option<String>,
}
```

### 28.2 Initial error codes

```text
interface_disabled
provider_disabled
unknown_operation
unknown_resource
invalid_arguments
invalid_schedule
invalid_timezone
revision_required
revision_conflict
idempotency_conflict
resource_not_found
workspace_unavailable
provider_unavailable
connector_unavailable
elevated_permissions_disabled
automation_already_running
execution_failed
storage_unavailable
internal_error
```

### 28.3 Error quality

Bad:

```json
{
 "error": "invalid input"
}
```

Required:

```json
{
 "ok": false,
 "error": {
 "code": "invalid_timezone",
 "message": "Timezone 'London' is not an IANA timezone identifier.",
 "retryable": true,
 "field_errors": [
 {
 "field": "trigger.timezone",
 "message": "Use an identifier such as Europe/London."
 }
 ],
 "suggested_action": "Retry with trigger.timezone set to Europe/London."
 }
}
```

---

## 29. Redaction and secret handling

### 29.1 Structured redaction

Before model-facing output, recursively redact values under keys matching known secret categories:

```text
password
secret
token
api_key
access_key
authorization
cookie
private_key
client_secret
```

Illustrative helper:

```rust
fn redact_value(value: &mut serde_json::Value) {
 match value {
 serde_json::Value::Object(object) => {
 for (key, value) in object {
 if is_sensitive_key(key) {
 *value = serde_json::Value::String("[REDACTED]".to_string());
 } else {
 redact_value(value);
 }
 }
 }

 serde_json::Value::Array(values) => {
 for value in values {
 redact_value(value);
 }
 }

 _ => {}
 }
}
```

### 29.2 Connector credentials

The control interface must not expose:

* connector environment values;
* connector authorization headers;
* keyring values;
* provider credentials.

It may expose:

```json
{
 "name": "gmail",
 "enabled": true,
 "available_to_provider": true
}
```

It must not expose:

```json
{
 "GMAIL_TOKEN": "..."
}
```

### 29.3 Free-text limitation

FalconDeck cannot reliably detect every credential pasted into a free-text automation instruction.

The product should:

* discourage secrets in instructions;
* recommend connector environment references or secure provider configuration;
* never claim that arbitrary free text has been fully redacted;
* omit full instructions from audit summaries;
* return full instructions only when the user explicitly reads one automation, not in default list results.

---

## 30. Pagination and response bounds

### 30.1 Default list projection

Default automation list fields:

```text
id
revision
name
state
trigger
target.provider
target.workspace_path
next_run_at
last_run_at
latest_outcome
```

The full instruction is omitted.

### 30.2 Stable ordering

Automations:

```text
updated_at descending, id ascending
```

Runs:

```text
queued_at descending, id ascending
```

Audit:

```text
occurred_at descending, id ascending
```

### 30.3 Cursor

Use an opaque encoded cursor derived from the last stable sort tuple.

Do not use a mutable list offset as the sole cursor.

Example internal cursor payload:

```json
{
 "updated_at": "2026-08-16T14:22:10Z",
 "id": "automation-9fc78b39"
}
```

---

## 31. Graphical interface requirements

### 31.1 Agent Control settings panel

Add a settings section containing:

* global agent-control toggle;
* provider toggles;
* default timezone;
* elevated-automation toggle;
* confirmation preferences;
* recent control changes.

Suggested component:

```text
apps/desktop/src/components/settings/AgentControlPanel.tsx
```

### 31.2 Automations interface

The initial desktop interface may be a settings-level view rather than a new major navigation concept.

It must show:

* name;
* state;
* schedule summary;
* timezone;
* provider;
* workspace;
* next run;
* last result;
* elevated permission warning;
* actions.

Actions:

```text
Create
Edit
Pause
Resume
Run now
View history
Delete
```

### 31.3 Editor

The editor supports:

* name;
* description;
* schedule type;
* schedule-specific fields;
* timezone;
* instruction;
* conditional/no-action mode;
* workspace;
* provider;
* thread strategy;
* model override;
* permission/sandbox mode;
* required connectors;
* concurrency policy;
* misfire policy.

The UI sends the same `ControlExecuteRequest` used by MCP.

### 31.4 Large-text safety

The instruction field may be large but should not render in the list.

The delete action requires a graphical confirmation.

Elevated automation creation requires an explicit warning.

---

## 32. Client API example

```typescript
export interface ControlExecuteRequest {
 operation: string;
 arguments: Record<string, unknown>;
 expected_revision?: number;
 idempotency_key?: string;
}

export interface ControlErrorDetail {
 code: string;
 message: string;
 retryable: boolean;
 field_errors: Array<{
 field: string;
 message: string;
 }>;
 current_revision?: number;
 suggested_action?: string;
}

export async function executeControlOperation<T>(
 client: DaemonClient,
 request: ControlExecuteRequest,
): Promise<T> {
 const response = await client.post<{
 ok: boolean;
 data?: T;
 error?: ControlErrorDetail;
 }>("/api/control/execute", request);

 if (!response.ok || !response.data) {
 throw new ControlOperationError(
 response.error ?? {
 code: "internal_error",
 message: "FalconDeck returned no control result.",
 retryable: false,
 field_errors: [],
 },
 );
 }

 return response.data;
}
```

---

## 33. Real-time state propagation

Control mutations should emit one lightweight normalized event:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ControlStateChanged {
 pub store_revision: u64,
 pub domains: Vec<ControlDomain>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ControlDomain {
 Settings,
 Automations,
 Runs,
 Audit,
}
```

Example unified event variant:

```rust
UnifiedEvent::ControlStateChanged {
 change: ControlStateChanged {
 store_revision: 42,
 domains: vec![
 ControlDomain::Automations,
 ControlDomain::Audit,
 ],
 },
}
```

Clients receiving the event refetch the affected resources.

Do not broadcast the full automation store in every event.

All current clients must be updated so the new event cannot break deserialisation. Clients that do not render automations may safely ignore it after parsing.

If adding this event would require disproportionate first-release work, the temporary fallback is short-interval polling while the automations panel is visible. The final acceptance target remains event-driven synchronisation.

---

## 34. Remote behaviour

Initial release:

* scheduling runs on whichever daemon owns the automation;
* headless and remote-host daemons use the same store and scheduler;
* the desktop connected directly to that daemon can manage its automations;
* mobile and remote-web management are not required;
* remote RPC operation names may be added in a subsequent release.

When remote control methods are added, the remote registration table and dispatcher must be changed together and covered by a test. The existing bridge requires methods to be registered before calls can be routed.

Suggested future methods:

```text
control.search
control.get
control.execute
```

Do not create separate remote operation names for every automation action.

---

## 35. Observability

### 35.1 Logging

Standard-input/output MCP logs go to standard error.

Daemon logs include:

* automation ID;
* run ID;
* provider;
* workspace path hash or safely formatted path;
* state transition;
* failure code;
* elapsed time.

Never log:

* connector secrets;
* authorization headers;
* full automation instructions by default;
* full provider responses.

### 35.2 Metrics-ready events

The implementation should make it possible to count:

```text
automation.created
automation.run.started
automation.run.succeeded
automation.run.no_action
automation.run.failed
automation.run.skipped_overlap
automation.run.skipped_dependency
control.operation.failed
```

No external analytics system is required for version one.

---

## 36. Security model

The agent control interface has the same effective local authority as the FalconDeck user and target provider configuration.

The implementation must:

* retain the existing loopback host protection;
* retain the current browser-origin restrictions;
* avoid exposing control routes outside the daemon’s existing API boundary;
* reject MCP-originated calls when disabled;
* prevent unregistered operation execution;
* validate typed arguments before mutation;
* avoid privilege escalation through automation defaults;
* redact known secret-bearing fields;
* use restrictive state-file permissions;
* audit all mutations;
* never allow a tool argument to select an arbitrary executable or internal route.

The built-in MCP connector is trusted FalconDeck code.

User-authored MCP connectors remain outside FalconDeck’s approval and sandbox enforcement, consistent with existing connector behaviour.

---

## 37. Test plan

### 37.1 Capability registry unit tests

* operation IDs are unique;
* registry order is deterministic;
* every mutation has input and output schemas;
* related operation IDs exist;
* exact ID search ranks first;
* summary search omits large schemas;
* full search includes schema and examples;
* search limit is enforced.

### 37.2 Schema and validation tests

* unknown fields are rejected;
* missing required fields produce field errors;
* invalid provider ID is rejected;
* relative workspace path is rejected;
* invalid timezone is rejected;
* six-field cron is rejected;
* interval below minimum is rejected;
* oversized instructions are rejected;
* elevated modes are rejected when disabled.

### 37.3 Schedule tests

* weekday cron in `Europe/London`;
* next occurrence before and after daylight-saving changes;
* nonexistent local time is skipped;
* ambiguous local time runs once;
* once schedule transitions to completed;
* `skip` misfire;
* `run_once` misfire;
* daemon restart recalculates `next_run_at`;
* paused automations have no next due dispatch.

### 37.4 Revision tests

* update succeeds with current revision;
* update increments revision;
* stale update produces `revision_conflict`;
* stale pause/delete produces conflict;
* run-now does not require revision.

### 37.5 Store tests

* missing store produces defaults;
* round-trip persistence;
* atomic replacement;
* malformed file is preserved;
* unsupported schema version is not overwritten;
* bounded run history;
* bounded audit history;
* idempotency record expiry;
* concurrent mutations cannot overwrite a newer state snapshot.

### 37.6 Redaction tests

* known secret keys are redacted recursively;
* connector environment values are absent;
* authorization headers are absent;
* automation list does not include full instructions;
* audit does not include instruction bodies;
* ordinary non-secret values are retained.

### 37.7 Control API integration tests

* search route;
* get route;
* execute create;
* execute update;
* pagination;
* field selection;
* interface disabled;
* provider disabled;
* invalid origin context;
* loopback protections remain active.

### 37.8 MCP protocol tests

Spawn the daemon binary’s MCP subcommand as a child process.

Test:

* modern `server/discover`;
* modern `tools/list`;
* legacy `initialize`;
* `notifications/initialized`;
* all three tool calls;
* malformed tool call;
* unknown tool;
* unknown method;
* deterministic tool ordering;
* structured and text output;
* no non-protocol output on standard output;
* diagnostics appear only on standard error;
* daemon-unavailable tool error;
* disabled-interface error.

### 37.9 Connector integration tests

Claude materialisation includes:

```json
{
 "mcpServers": {
 "falcondeck": {
 "command": "/path/to/falcondeck-daemon",
 "args": ["mcp"],
 "env": {}
 }
 }
}
```

Codex overrides include the equivalent `mcp_servers.falcondeck.*` values.

ACP session configuration includes the equivalent standard-input/output entry.

Also test:

* disabled global setting omits the connector;
* disabled provider omits it;
* user connector named `falcondeck` cannot override it;
* user connectors remain otherwise unchanged.

### 37.10 Scheduler integration tests

Use a fake automation dispatcher rather than a live external model.

Test:

* due automation dispatches once;
* managed thread ID is persisted;
* overlapping run respects policy;
* required connector missing produces skipped dependency;
* provider failure produces failed run;
* terminal event completes run;
* conditional marker produces `succeeded_no_action`;
* scheduler wakes after an automation is created;
* scheduler does not run a paused automation.

### 37.11 Desktop tests

* settings toggle state;
* provider toggle state;
* automation list rendering;
* create form validation;
* edit submits current revision;
* revision conflict is shown and refetches;
* pause/resume;
* run now;
* delete confirmation;
* control-state event causes refetch;
* elevated mode warning.

---

## 38. Acceptance criteria

The release is accepted when all of the following are true.

### 38.1 Public interface

* The built-in MCP server exposes exactly three FalconDeck tools.
* Claude can discover and invoke them.
* Codex can discover and invoke them.
* Unsupported operations cannot be executed by guessing internal paths.

### 38.2 Automations

* A recurring automation can be created through Claude.
* The equivalent recurring automation can be created through Codex.
* The equivalent automation can be created through the desktop UI.
* One-time, cron, interval and conditional-prompt definitions validate correctly.
* Automations survive daemon restart.
* The scheduler dispatches work through the existing thread/turn system.
* Pause, resume, update, run-now and delete work.
* Run history and latest outcome are visible.
* One-time automations become completed.

### 38.3 Reliability

* Invalid arguments cause no state mutation.
* Stale revisions cannot overwrite newer edits.
* Duplicate creation retries with the same idempotency key do not create duplicates.
* Overlapping runs follow the configured concurrency policy.
* Missed runs follow the configured misfire policy.
* Large lists remain paginated and bounded.

### 38.4 Security and control

* The interface is enabled by default.
* Global disablement prevents MCP-originated operations.
* Per-provider disablement prevents that provider’s operations.
* Existing automations continue when conversational control is disabled.
* Elevated automation modes require explicit enablement.
* Known secret-bearing fields are redacted.
* Connector credentials are never returned.
* Mutations produce audit entries.

### 38.5 Synchronisation

* MCP-originated changes appear in the graphical interface without restarting FalconDeck.
* Graphical-interface changes are immediately visible through `falcondeck_get`.
* The daemon is the sole writer of control state.

### 38.6 Protocol compatibility

* Modern MCP discovery and tool calls work.
* Initialization-based clients work.
* Standard output contains only MCP protocol messages.
* Tool list ordering is deterministic.
* Structured output includes a text fallback.

---

## 39. Implementation sequence and logical commit plan

Implementation should be committed in independently useful chunks.

### Commit 1: Shared control domain types

```text
feat(control): add shared automation and control protocol types
```

Changes:

* add `falcondeck-core/src/control.rs`;
* add TypeScript equivalents in `packages/client-core`;
* add serialization and schema tests;
* no scheduler or MCP behaviour yet.

### Commit 2: Control store and capability registry

```text
feat(control): add persisted control store and capability registry
```

Changes:

* store;
* atomic persistence;
* revisions;
* audit;
* idempotency;
* deterministic search;
* unit tests.

At this point, work is durable even though nothing schedules yet.

### Commit 3: Generic control API

```text
feat(control): expose daemon control search get and execute API
```

Changes:

* three loopback API routes;
* create/update/pause/resume/delete operations;
* client-core methods;
* HTTP integration tests.

### Commit 4: Scheduler and automation dispatch

```text
feat(automation): add daemon scheduler and native turn dispatch
```

Changes:

* due-time calculation;
* timezone support;
* misfires;
* concurrency;
* workspace path resolution;
* managed threads;
* run records;
* event completion tracking;
* scheduler tests.

### Commit 5: Built-in MCP server

```text
feat(mcp): add FalconDeck control stdio server
```

Changes:

* `falcondeck-daemon mcp`;
* modern and legacy protocol support;
* three public tools;
* structured output;
* subprocess tests.

### Commit 6: Provider connector injection

```text
feat(connectors): expose FalconDeck control tools to agent providers
```

Changes:

* built-in in-memory connector;
* Claude materialisation;
* Codex materialisation;
* ACP materialisation;
* enablement enforcement;
* collision tests.

### Commit 7: Desktop settings and automation UI

```text
feat(desktop): add agent control and automation management
```

Changes:

* settings panel;
* automation list/editor;
* run history;
* revision conflict handling;
* client tests.

### Commit 8: Event synchronisation and remaining clients

```text
feat(control): propagate control state changes to clients
```

Changes:

* shared control-change event;
* desktop handling;
* safe ignore/handling in mobile and remote web;
* protocol tests.

### Commit 9: Documentation and end-to-end verification

```text
docs(control): document agent control and scheduled automations
```

Changes:

* user documentation;
* architecture documentation;
* example prompts;
* complete test and lint pass;
* remove the temporary GitHub write-test file.

No commit should contain several hours of uncommitted implementation.

---

## 40. Dependencies

The implementation may introduce well-maintained crates for:

* JSON Schema generation;
* cron parsing;
* IANA timezone handling;
* local system timezone detection.

Suggested categories, without pinning this PRD to exact versions:

```text
schemars
chrono-tz
a maintained five-field cron parser
iana-time-zone
```

The implementation should not create a custom cron parser unless a documented technical constraint makes all suitable libraries unusable.

Dependency additions must be justified in the commit message and covered by schedule tests.

---

## 41. Explicit design decisions

The following questions are resolved by this PRD.

### Does an automation store a workspace ID?

No. It stores a canonical workspace path.

### Does FalconDeck write its own server into `connectors.json`?

No. It is injected in memory as a reserved built-in connector.

### Does MCP replace Codex app-server?

No. App-server continues to drive Codex; MCP provides FalconDeck control tools to the Codex agent.

### Does disabling MCP pause automations?

No. It disables conversational control only.

### Does a conditional automation execute arbitrary code?

No. It runs a structured scheduled agent instruction and recognises a defined no-action marker.

### Does the daemon parse natural-language schedules?

No. The agent or UI converts natural language into a structured trigger.

### Does version one use MCP Tasks?

No. `run_now` returns an automation-run resource that can be inspected through `falcondeck_get`.

### Does FalconDeck store the full automation response?

No. The native thread remains authoritative; FalconDeck stores bounded run metadata and a preview.

### Are automatic retries enabled?

No, because provider tasks may have external side effects.

### Are remote web and mobile management required?

No, but the service is designed so generic remote `control.search`, `control.get` and `control.execute` can be added later.

---

## 42. Future scope

Future versions may add capabilities through the same registry:

```text
provider.defaults.update
workspace.settings.update
connector.create
connector.update
connector.delete
host.provision
host.command
remote.device.revoke
thread.create
thread.update
thread.archive
```

Potential automation extensions:

* webhook triggers;
* filesystem event triggers;
* connector event triggers;
* automation dependencies;
* retry policies for explicitly idempotent tasks;
* notification destinations;
* managed-thread rollover;
* team ownership;
* cloud-hosted always-on scheduling;
* MCP Tasks integration;
* MCP Apps management interface;
* remote and mobile automation management;
* import/export;
* reusable automation templates.

These additions must continue to use the same three-tool public interface rather than expanding the top-level tool catalogue.

---

## 43. Definition of done

The feature is complete only when:

1. all acceptance criteria pass;
2. the daemon, not the MCP process, owns state;
3. both Codex and Claude receive the built-in connector;
4. current and initialization-based MCP clients are tested;
5. schedule timezone and daylight-saving behaviour is tested;
6. no automation uses a transient workspace ID as its durable locator;
7. control state survives restart;
8. mutation conflicts are safe;
9. credentials are not exposed;
10. graphical and conversational changes remain synchronised;
11. the full repository formatting, Rust tests, linting, TypeScript checks and relevant application tests pass;
12. implementation documentation is committed;
13. the temporary `docs/chatgpt-write-test.md` file is deleted.

---

## Protocol implementation notes

The current MCP specification uses a stateless core, optional `server/discover`, deterministic and cacheable list results, and JSON Schema 2020-12 for tool schemas. The standard-input/output transport still uses newline-delimited UTF-8 JSON-RPC, requires protocol-only output on standard output and permits diagnostics on standard error. ([Model Context Protocol][3])

Claude Code supports loading local MCP servers through `--mcp-config`, which aligns with FalconDeck’s existing connector materialisation approach. ([docs.anthropic.com][4])

[1]: https://openai.com/pt-BR/index/unlocking-the-codex-harness/?utm_source=chatgpt.com "Desvendando os segredos do Codex: como construímos o App Server | OpenAI"
[2]: https://blog.modelcontextprotocol.io/posts/2026-07-28/?utm_source=chatgpt.com "The 2026-07-28 Specification | Model Context Protocol Blog"
[3]: https://modelcontextprotocol.io/specification/draft/basic/transports?utm_source=chatgpt.com "Transports - Model Context Protocol"
[4]: https://docs.anthropic.com/pt/docs/claude-code/sdk?utm_source=chatgpt.com "Claude Code SDK - Anthropic"

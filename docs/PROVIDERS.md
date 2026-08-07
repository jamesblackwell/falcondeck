# Multi-Provider Architecture

Research date: 2026-08-06
Last updated: 2026-08-07

Status: Partially implemented. Shipped 2026-08-07: the open `AgentProvider`
string id (wire-compatible newtype, §6), extended capability flags (§7),
client-side provider passthrough and dynamic pickers, and the generic
`AcpAdapter` of §4/§9 (`crates/falcondeck-daemon/src/acp.rs` +
`app/acp_threads.rs`) with `providers.json` configuration — verified
end-to-end against `opencode acp` (streamed text, tool calls, interrupt).
Configured providers whose binary is missing stay hidden until installed, so
a Grok entry activates the moment `npm install -g @xai-official/grok` runs.
Still open: the Tier-1 native OpenCode adapter (§8, richer than its ACP mode),
skill-type reshaping (§6), per-provider bin maps (§1 obstacle 3), and ACP
`session/load` for resuming sessions across daemon restarts.

FalconDeck supports exactly two agent CLIs today, both hardcoded: OpenAI Codex
(`codex app-server`, long-lived JSON-RPC session) and Claude Code (`claude -p`,
one child process per turn). This document specifies how to add more — OpenCode
and xAI's Grok Build specifically, and arbitrary agent CLIs generally.

## 1. What is coupled today

`falcondeck_core::AgentProvider` (`crates/falcondeck-core/src/lib.rs:541`) is a
two-variant enum with `#[serde(rename_all = "snake_case")]`, so its wire strings
are `"codex"` and `"claude"`, and `Codex` is `#[default]`. There is no `impl`
block — every dispatch is an inline `match` or `==`.

There are 54 non-test match sites in `crates/` (77 including tests), 28 of them
in `app/workspace_ops.rs` alone — start thread, send turn, goals, interrupt,
review, reconnect. The rest are in `app/agent_helpers.rs` (6, skill selection),
`app.rs` and `app/storage.rs` (8, defaults and placeholders), `skills.rs` (2),
and seven stamping/routing sites across `claude.rs`, `app/threads.rs`,
`app/notifications.rs`, and `codex/thread_list.rs`.

Five structural obstacles, in descending order of difficulty:

1. **`SkillProviderTranslations`** (`lib.rs:468`) has two *named fields of
   different types* — `codex: Option<CodexSkillTranslation>` (`native_id`,
   `native_name`) and `claude: Option<ClaudeSkillTranslation>` (`command_name`,
   `prompt_reference_path`). Not a map. `merge_skills` merges them field by field.
2. **`SkillAvailability { Codex, Claude, Both }`** — `Both` is a two-provider
   concept. `merge_availability` (`skills.rs:307`) is a five-arm lattice.
3. **Per-provider named fields**: `AppState.inner.{codex_bin, claude_bin}`,
   `ManagedWorkspace.{codex_session, claude_runtime}`, `DaemonConfig.{codex_bin,
   claude_bin}`, `--codex-bin=`/`--claude-bin=`. All need to become keyed maps.
4. **`normalizeProvider`** (`packages/client-core/src/normalization.ts:65`) is
   `value === 'claude' ? 'claude' : 'codex'`. A daemon emitting `"opencode"`
   would silently relabel every one of those threads `codex` in all three
   clients. This is the single highest-risk line in the migration — it fails as
   data corruption, not as a type error.
5. **Three hardcoded provider lists** in the UI: `model-selector.tsx:20`
   (`['codex','claude'].map(...)`), `mobile/InputToolbar.tsx:28` (`PROVIDERS`
   const with its own labels), and `desktop/App.tsx:78` (persisted composer
   selections keyed by a literal loop). Everything *downstream* of provider
   selection — models, efforts, skills, accounts — already reads
   `workspace.agents` and needs no change.

Two things are already provider-agnostic and should be left alone:
`agent_binary.rs` takes a plain `bin_name: &str`, and
`conversation_helpers::tool_display_metadata` is shared by both providers.

`AgentCapabilitySummary` (`lib.rs:704`) exists but has exactly one flag,
`supports_review`. Every other capability difference is an ad-hoc
`if provider != Codex` check.

## 2. Research: OpenCode

Verified empirically against a locally installed **opencode 1.18.9** by running
`opencode serve` and reading its OpenAPI document from `/doc` (478 KB, 472
schemas). This is measured, not documented-and-hoped.

OpenCode is a headless HTTP server with a durable, event-sourced session model.
Its `/api/*` ("v2") surface is a better fit for FalconDeck than Codex's
app-server:

| Need | OpenCode |
|---|---|
| Bootstrap | `GET /api/health`, `GET /api/provider`, `GET /api/agent` |
| Models | `GET /api/model` — 415 entries with `capabilities`, `cost`, `limit.context`, `variants` |
| Thread list | `GET /api/session?directory=&limit=&order=&search=` |
| Hydration | `GET /api/session/{id}/message`, `GET /api/session/{id}/history` |
| Start thread | `POST /api/session` `{agent, model, location}` |
| Send turn | `POST /api/session/{id}/prompt` `{prompt, delivery: steer\|queue, resume}` |
| Stream | `GET /api/session/{id}/event?after=<seq>` — SSE, replays durable events then continues |
| Interrupt | `POST /api/session/{id}/interrupt` |
| Approvals | `GET /api/session/{id}/permission`, `POST .../{requestID}/reply` (`once\|always\|reject`) |
| Questions | `POST /api/session/{id}/question/{requestID}/reply` |
| Model switch | `POST /api/session/{id}/model` (mid-session) |
| Skills | `GET /api/skill` |
| Compact | `POST /api/session/{id}/compact` |

The event stream maps almost one-to-one onto our `ConversationItem` model:
`session.next.text.{started,delta,ended}`, `...reasoning.{started,delta,ended}`,
`...tool.{input.started,input.delta,input.ended,called,progress,success,failed}`,
`...step.{started,ended,failed}`, plus compaction, revert, and agent/model
switches. Every event carries `durable: {aggregateID, seq, version}`.

Two properties neither current provider has. **Resumable streams**: `?after=<seq>`
means a daemon restart replays exactly the missed events, where Codex reconnect
currently marks every thread `requires_resume`. **Mid-turn steering**:
`delivery: "steer"` injects a message into a running turn.

Gaps: no goal/objective concept, and no sandbox-mode knob. Permissions are a
per-agent action/resource/effect ruleset (`allow`/`ask`/`deny`) — richer than
Claude's `--permission-mode` but shaped differently.

OpenCode also ships `opencode acp`, an Agent Client Protocol server. See §4.

## 3. Research: Grok Build

**Not installed locally** (`which grok` → not found). Findings below are from
xAI's docs and secondary sources; treated as *unverified* until we install it.

Grok Build is xAI's official agentic CLI, shipped 14 May 2026,
`npm install -g @xai-official/grok`. Three operating modes: interactive TUI,
headless, and ACP.

Verified from xAI's headless-scripting docs:

- `-p, --single <PROMPT>` — one-shot prompt
- `--output-format plain|json|streaming-json` — streaming-json is NDJSON events
- `-s, --session-id <ID>` — create or name a session
- `-r, --resume <ID>`, `-c, --continue` — resume; sessions persist in `~/.grok/sessions`
- `-m, --model <MODEL>`, `--cwd <PATH>`
- `--always-approve` — auto-approve tool execution; tool allow/deny lists and
  `--max-turns` also exist
- `grok agent stdio` — ACP server over JSON-RPC on stdin/stdout

Uncertain until we install it: the streaming-json event schema (docs say
"newline-delimited JSON events" without publishing one), whether a stream-json
*input* format exists for image attachments, whether approvals can be brokered
interactively in headless mode (Claude does this via a `PreToolUse` hook;
Grok's documented options are blanket allow/deny lists), and whether any
model-listing command exists.

The headless shape is close to Claude Code's — spawn per turn, `--resume` for
continuity, NDJSON out. The ACP shape is closer to Codex's — one long-lived
process, structured permission requests.

## 4. The key finding: ACP is the common denominator

Both OpenCode and Grok Build speak the Agent Client Protocol. So do Gemini CLI
and several others. ACP is JSON-RPC over stdio, and its method set is already
close to what our adapter trait needs. Client→agent: `initialize`,
`authenticate`, `session/new`, `session/load`, `session/prompt`,
`session/cancel`, `session/set_mode`. Agent→client: `session/update`
notifications (message chunks, thought chunks, tool calls and updates, plans),
`session/request_permission`, `fs/*`, terminal methods, `elicitation/create`.
`initialize` negotiates `loadSession`, `fs.*`, `terminal`, and `auth.logout`.

This gives the architecture a two-tier answer:

**Tier 1 — native adapters** where the provider's own API is richer than ACP.
Codex (app-server) and OpenCode (v2 HTTP) both qualify: ACP has no equivalent of
OpenCode's resumable `?after=<seq>` stream, session listing, model catalogue, or
steering delivery.

**Tier 2 — one generic `AcpAdapter`** that covers every other ACP-speaking CLI,
configured by data rather than code. This is the answer to "bring your own agent
CLI": a user declares a command in config and gets a working provider with no
Rust changes.

```jsonc
// falcondeck.json
"providers": {
  "grok":   { "kind": "acp", "command": ["grok", "agent", "stdio"], "label": "Grok" },
  "gemini": { "kind": "acp", "command": ["gemini", "--experimental-acp"], "label": "Gemini" }
}
```

Recommendation: use ACP for Grok rather than its headless NDJSON mode. ACP gives
a documented event schema, a persistent session, and structured permission
requests — all three of which headless mode lacks or leaves unspecified. It also
means Grok falls out of Tier 2 for free.

## 5. The `ProviderAdapter` trait

Split along the seam that already exists in the code: a stateless descriptor
that knows how to connect, and a live per-workspace session. This mirrors
`CodexSession` and `ClaudeRuntime` without forcing them to converge prematurely.

```rust
/// One instance per provider, held in the registry. Stateless.
#[async_trait]
pub trait ProviderAdapter: Send + Sync {
    fn id(&self) -> AgentProvider;
    fn label(&self) -> &str;
    fn binary_name(&self) -> &str;
    /// Static capability declaration; may be refined after connect().
    fn capabilities(&self) -> AgentCapabilitySummary;

    async fn connect(&self, cx: &WorkspaceCx) -> Result<ProviderBootstrap, DaemonError>;
}

/// A live connection to one provider in one workspace.
#[async_trait]
pub trait ProviderSession: Send + Sync {
    async fn provider_metadata(&self) -> Result<ProviderMetadata, DaemonError>;

    async fn list_threads(&self) -> Result<Vec<HydratedThread>, DaemonError>;
    async fn hydrate_thread(&self, thread_id: &str) -> Result<HydratedThread, DaemonError>;
    async fn start_thread(&self, spec: StartThreadSpec) -> Result<ThreadHandle, DaemonError>;
    async fn resume_thread(&self, thread_id: &str) -> Result<(), DaemonError>;

    async fn send_turn(&self, spec: TurnSpec, sink: EventSink) -> Result<TurnHandle, DaemonError>;
    async fn interrupt_turn(&self, thread_id: &str) -> Result<(), DaemonError>;

    async fn respond_to_request(
        &self, request: &InteractiveRequestRef, decision: ApprovalDecision,
    ) -> Result<(), DaemonError>;

    async fn set_goal(&self, thread_id: &str, goal: GoalSpec) -> Result<(), DaemonError>;
    async fn clear_goal(&self, thread_id: &str) -> Result<(), DaemonError>;

    async fn shutdown(&self) -> Result<(), DaemonError>;
    fn is_closed(&self) -> bool;
}
```

`EventSink` is the load-bearing piece. Today Codex pushes notifications through
`app/notifications.rs::ingest_notification` while Claude goes through an
entirely separate path in `app/threads.rs::monitor_claude_turn` — yet both end
up producing the same `ConversationItem`s. The trait makes that convergence
explicit: adapters emit a normalized `ProviderEvent`, and one shared translator
turns those into `ConversationItem` + `UnifiedEvent`.

```rust
pub enum ProviderEvent {
    ThreadStarted { native_id: String, title: Option<String> },
    TurnStarted, TurnCompleted { usage: Option<TokenUsage> },
    AssistantDelta { item_id: String, text: String },
    ReasoningDelta { item_id: String, text: String },
    ToolCall   { call_id: String, name: String, input: Value },
    ToolUpdate { call_id: String, status: ToolStatus, output: Option<String> },
    Plan(ThreadPlan),
    Diff(DiffPayload),
    GoalUpdated(Option<ThreadGoal>),
    InteractiveRequest(InteractiveRequest),
    Service(String),
    Error { message: String, fatal: bool },
}
```

Adapters that cannot produce a variant simply never emit it — Claude emits no
`Plan`, `Diff`, or `Reasoning` today, and that stays true without special-casing.

Two deliberate omissions. `start_review` stays outside the trait behind the
existing `supports_review` flag; only Codex has it and inventing a generic
review contract for one implementation would be speculative. Goal support stays
*in* the trait, because it already has two genuinely different implementations
(Codex `thread/goal/set` RPC vs Claude's synthesized `/goal` turn) and a third
provider will need a third answer.

## 6. Opening the `AgentProvider` enum

Replace the closed enum with a nominal string newtype:

```rust
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct AgentProvider(Cow<'static, str>);

impl AgentProvider {
    pub const CODEX: Self = Self(Cow::Borrowed("codex"));
    pub const CLAUDE: Self = Self(Cow::Borrowed("claude"));
    pub const OPENCODE: Self = Self(Cow::Borrowed("opencode"));
}

impl Default for AgentProvider {
    fn default() -> Self { Self::CODEX }
}
```

`#[serde(transparent)]` over a string produces byte-identical wire output to
today's `rename_all = "snake_case"` enum: `"codex"` and `"claude"`. **The
protocol does not change and persisted state loads unmodified.** The explicit
`Default` impl is required — deriving it on a newtype would yield an empty
string and silently strip the provider from older `daemon-state.json` files
where the field is absent.

The real cost is losing exhaustive matching. The mitigation is that after the
registry refactor there should be no `match provider` sites left at all —
dispatch goes through `registry.get(&provider)?.session()`. The compile-time
guarantee changes from "every match handles both providers" to "every provider
implements the trait," which is the stronger of the two.

The two skill types need genuine reshaping, both with serde compat shims:

- `SkillAvailability` → `Vec<AgentProvider>`, where empty means "all providers."
  A custom `Deserialize` maps legacy `"codex"`/`"claude"` to single-element
  vectors and `"both"` to empty. `merge_availability`'s five-arm lattice becomes
  a set union.
- `SkillProviderTranslations` → `BTreeMap<AgentProvider, SkillTranslation>`
  where `SkillTranslation` is the union of today's fields (`native_id`,
  `native_name`, `command_name`, `prompt_reference_path`), all optional. A
  custom `Deserialize` accepts the legacy `{codex: {...}, claude: {...}}` object.

Phased migration, each step independently shippable:

1. Add the trait and registry; register `CodexAdapter` and `ClaudeAdapter`
   wrapping the existing code verbatim. Keep the enum. No behavior change.
2. Move dispatch sites from `match` to registry lookup, one call site at a time.
3. Swap the enum for the newtype once no `match` sites remain.
4. Fix `normalizeProvider` to pass through, and derive UI provider lists from
   `workspace.agents`.
5. Add new adapters.

Steps 4 and 5 must not be reordered. Shipping a daemon that emits `"opencode"`
to a client that still coerces it to `"codex"` mislabels real user threads.

## 7. Capability flags

Extend `AgentCapabilitySummary`. Every field `#[serde(default)]`, so old clients
and old daemons interoperate with the fields they know.

```rust
pub struct AgentCapabilitySummary {
    pub supports_review: bool,             // existing
    pub supports_goals: bool,
    pub goal_mechanism: GoalMechanism,     // Native | PromptCommand | Unsupported
    pub supports_sandbox: bool,
    pub sandbox_modes: Vec<String>,
    pub supports_permission_modes: bool,
    pub permission_modes: Vec<String>,
    pub supports_approvals: bool,
    pub supports_interrupt: bool,
    pub supports_resume: bool,
    pub supports_images: bool,
    pub supports_skills: bool,
    pub supports_collaboration_modes: bool,
    pub supports_steering: bool,           // mid-turn injection; OpenCode only
    pub supports_mid_session_model_switch: bool,
}
```

Enumerating `sandbox_modes` and `permission_modes` as *lists* rather than
booleans lets the UI render each provider's real options without a client-side
table. Today those knobs are unvalidated `Option<String>` on `ThreadAgentParams`
and have no TS type at all, so this is additive either way.

Frontend consequences:

- `ProviderSelector` renders `workspace.agents.map(...)` instead of
  `['codex','claude']`. Labels come from a new `label` field on
  `WorkspaceAgentSummary` — delete `app-utils.ts:providerLabel` and mobile's
  `PROVIDERS` const.
- `desktop/App.tsx:78`'s persisted composer map keys off `workspace.agents`.
- Provider seeds (`useState<AgentProvider>('codex')` in desktop and remote-web)
  become `defaultProvider(workspace)`.
- Feature affordances gate on flags, not identity: the review button on
  `supports_review`, the goal editor on `supports_goals`, the sandbox picker on
  `sandbox_modes.length > 0`.

## 8. OpenCode adapter sketch

Lifecycle: spawn `opencode serve --port 0 --hostname 127.0.0.1`, parse the port
from stdout, hold the child for the workspace's lifetime. Set
`OPENCODE_SERVER_PASSWORD` and send it as basic auth — without it the server
logs `"server is unsecured"`, and it binds a real TCP port on the user's machine.

| Trait method | OpenCode call |
|---|---|
| `connect` | spawn `serve`, poll `GET /api/health`, then `/api/provider`, `/api/model`, `/api/agent` |
| `provider_metadata` | `GET /api/provider` + `GET /api/model` |
| `list_threads` | `GET /api/session?directory=<workspace>` |
| `hydrate_thread` | `GET /api/session/{id}/message` |
| `start_thread` | `POST /api/session {agent, model, location}` |
| `send_turn` | `POST /api/session/{id}/prompt {prompt, delivery:"queue"}`, then consume `GET /api/session/{id}/event?after=<seq>` |
| `interrupt_turn` | `POST /api/session/{id}/interrupt` |
| `resume_thread` | no-op — sessions are durable server-side |
| `respond_to_request` | `POST /api/session/{id}/permission/{reqID}/reply {once\|always\|reject}` |
| `set_goal` / `clear_goal` | unsupported → `goal_mechanism: Unsupported` |

Event mapping is direct: `text.delta` → `AssistantDelta`, `reasoning.delta` →
`ReasoningDelta`, `tool.called` → `ToolCall`, `tool.{progress,success,failed}` →
`ToolUpdate`, `permission.v2.asked` → `InteractiveRequest`, `step.failed` →
`Error`. Persist the last `durable.seq` per thread so a daemon restart resumes
the stream instead of marking threads `requires_resume`.

Degraded: no goals, no sandbox modes. `ApprovalDecision::AlwaysAllow` maps to
`"always"` — a cleaner fit than Claude, where we maintain
`claude_always_allowed_tools` in daemon memory ourselves. The model catalogue is
far larger than Codex's (415 entries spanning third-party providers), so the
model selector will need grouping by `providerID`/`family`.

## 9. Grok adapter sketch

Implement as configuration over the generic `AcpAdapter`, not as bespoke Rust.

| Trait method | ACP call |
|---|---|
| `connect` | spawn `grok agent stdio`, `initialize` → capability negotiation |
| `provider_metadata` | from `initialize` result; auth via `authenticate` or `GROK_CODE_XAI_API_KEY` |
| `list_threads` | **not in ACP** — scan `~/.grok/sessions`, mirroring `claude.rs:hydrate_threads` |
| `hydrate_thread` | `session/load` if `loadSession` was negotiated, else session-file parse |
| `start_thread` | `session/new` |
| `send_turn` | `session/prompt`, consume `session/update` notifications |
| `interrupt_turn` | `session/cancel` |
| `respond_to_request` | reply to `session/request_permission` |
| `set_goal` / `clear_goal` | unsupported |

`session/update` variants map cleanly: `agent_message_chunk` → `AssistantDelta`,
`agent_thought_chunk` → `ReasoningDelta`, `tool_call` → `ToolCall`,
`tool_call_update` → `ToolUpdate`, `plan` → `Plan`.

Two real unknowns: thread listing (ACP has no enumeration method, so we need
Grok's on-disk session format, exactly as we already do for Claude) and whether
permission-mode knobs exist beyond `--always-approve`. Both need the CLI
installed to resolve. Until then, ship Grok with `supports_goals: false`,
`supports_sandbox: false`, and thread listing limited to sessions FalconDeck
itself created.

## 10. Phased plan

**Phase 1 — registry and capability flags. No behavior change. ~5–7 days.**
Introduce `ProviderAdapter`/`ProviderSession`/`ProviderEvent` and wrap the
existing Codex and Claude code without rewriting it. Convert
`AppState.{codex_bin, claude_bin}` and `ManagedWorkspace.{codex_session,
claude_runtime}` to provider-keyed maps. Extend `AgentCapabilitySummary` and
populate it from adapters. Fix `normalizeProvider` to pass through, add
`permission_mode`/`sandbox_mode` to the TS types, and derive UI provider lists
from `workspace.agents`. Ship this first: it is pure refactor with existing
tests as the safety net, and it makes everything after it additive.

**Phase 2 — open the enum + skill reshaping. ~3–4 days.** Newtype swap,
`SkillAvailability` → `Vec<AgentProvider>`, `SkillProviderTranslations` → map,
both with compat deserializers. Round-trip tests against a real pre-migration
`daemon-state.json`.

**Phase 3 — OpenCode adapter behind a feature flag. ~6–8 days.** Server
lifecycle and port handshake are the fiddly part; the API surface itself is
well-specified and locally verifiable. Includes durable-seq persistence and
model-catalogue grouping.

**Phase 4 — generic ACP adapter + Grok. ~6–9 days.** The `AcpAdapter` is most of
this; Grok is then config plus its session-file reader. Estimate assumes Grok's
on-disk session format is parseable, which is unverified.

Phases 3 and 4 are independent and could run in parallel. Phase 1 gates both.

## 11. Open questions

- Is the OpenCode server per-workspace or one process serving all workspaces via
  `?directory=`? One process is cheaper; per-workspace matches the current
  `ManagedWorkspace` ownership model. Leaning per-workspace for phase 3.
- Does OpenCode's permission ruleset need to surface in the UI, or is
  ask/allow/deny at request time sufficient? Sufficient for phase 3.
- Should `Both` in existing user skill files keep meaning "codex and claude" or
  "all providers"? Proposed: all providers, which is the natural reading and
  requires no file rewrites.
- Grok's headless NDJSON schema and session-file format — blocked on installing
  the CLI.

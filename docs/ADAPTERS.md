# Agent adapters: how harnesses plug into FalconDeck

The reference for how FalconDeck talks to agent harnesses, what the seams are,
and how to add a new one. Written 2026-08-07, after the ProviderRuntime
refactor landed.

## The design in one paragraph

FalconDeck normalizes every harness into one vocabulary — `ConversationItem`
for output, `UnifiedEvent` for updates, `AgentCapabilitySummary` for what the
agent can do — and keeps harness-specific dispatch behind exactly one seam
(`ProviderRuntime`). UI never branches on provider id; it branches on
**capability flags and data presence** (a model list, a mode list, a skills
list). That is the whole trick for "same UX, any harness": a new agent that
advertises nothing gets the plain chat experience; every capability it does
advertise lights up the corresponding UI affordance the user already knows.

## The three tiers of integration

| Tier | Cost | What you get |
|---|---|---|
| **1. ACP config entry** | zero code — one entry in `providers.json` (or Settings → Agents) | chat, streaming, tool-call cards, plans, permission requests, interrupt, MCP connectors, session modes, images + resume where the agent supports them |
| **2. ACP + capability refinement** | small — extend `AcpRuntime::capability_summary` / `advertised_models` parsing | model picker, mode pickers, anything the agent advertises in `initialize` |
| **3. Native adapter** | large — a new backend module + `ProviderRuntime` variant | everything, including harness-specific RPCs (Codex: goals, review; Claude: hooks-based approvals) |

Tier 1 is the answer to "a new agent harness launches tomorrow". ACP is the
industry's common denominator (Zed's protocol; spoken by OpenCode, Gemini
CLI, Goose, Grok…), so most new harnesses arrive with an ACP mode. Native
adapters are reserved for harnesses whose extra surface earns the maintenance
(today: exactly two).

## The seams, and the invariants that keep them clean

1. **`ProviderRuntime` (app/provider_runtime.rs)** — the ONLY place codex /
   claude are recognized by name for routing. Six operations dispatch through
   it. Invariant: never compare `provider == CODEX/CLAUDE` at a call site to
   choose behavior; either dispatch through the seam or gate on a capability.
2. **Open provider ids** — `AgentProvider` is a string, not an enum. Both
   normalizers (TS `normalizeProvider`, Rust `parse_agent_provider`) pass
   unknown ids through. Invariant: mapping an unknown id to a default
   silently routes threads to the wrong agent; both sides have shipped that
   bug once — don't reintroduce it.
3. **`AgentCapabilitySummary`** — flags (`supports_review/goals/images/…`)
   plus open mode lists. UI gates on these, never on provider id. Placeholder
   workspaces fall back to compiled-in declarations
   (`ProviderRuntime::default_capabilities`). Invariant: a new UI affordance
   for a harness ability gets a capability flag, not a provider check; the
   dispatch arm stays as a backstop refusal.
4. **One item vocabulary** — all three ingestion pipelines (Codex JSON-RPC
   notifications, Claude NDJSON monitor, ACP event pump) converge on
   `push_conversation_item`. Renderers see `ConversationItem`, never raw
   harness output. Invariant: harness quirks are normalized at ingestion, not
   rendered around.
5. **Remote RPC registration** — `REMOTE_RPC_METHODS` in remote_bridge.rs is
   bound to the dispatcher by a test
   (`every_registered_remote_rpc_method_dispatches`); the relay only routes
   registered methods, so the two must agree. Add the arm and the list entry
   together; the test fails otherwise.
6. **Config over code** — `providers.json` (agents) and `connectors.json`
   (MCP servers) are re-read at spawn/snapshot boundaries; edits apply
   without a restart. Invariant: keep it that way — cached config is how
   hot-reload quietly dies.

## Known traps (deliberate, documented, easy to "fix" wrongly)

- **Codex takes raw request params, Claude takes resolved thread params** in
  `TurnSpec` (`requested_model_id` vs `thread.agent`). Unifying them changes
  what Codex receives for "unset". The struct split is intentional.
- **Backend handles resolve at use time, not dispatch time** — eager
  resolution would break lazy ACP spawn and placeholder-workspace semantics
  (module doc in provider_runtime.rs).
- **`availability` on skills is a legacy projection** of the open
  `providers` list, kept for old clients. New code reads `providers`.
- **A removed provider with a live runtime keeps serving until restart** —
  coherent-degraded by choice; the picker drops it once the runtime dies.

## Debts (acknowledged, sequenced — see PLATFORM.md Phase 0)

- Turn/status lifecycle handling is still hand-rolled per ingestion pipeline
  (item vocabulary converged; the state transitions around it did not).
- `ThreadAgentParams` carries provider-flavored fields (`permission_mode`,
  `sandbox_mode`) rather than one generic mode concept — ACP session modes
  already piggyback on `permission_modes`, which is the direction to finish.
- `WorkspaceSummary` still duplicates Codex's models/account at top level for
  pre-multi-provider clients; retire at the typegen/versioning phase.
- TS types are hand-mirrored from Rust until Phase 0 typegen lands.

## Adding a provider: the checklist

1. `providers.json` entry (or Settings → Agents). Done — for most agents,
   stop here.
2. Agent advertises models/capabilities in `initialize` beyond what
   `capability_summary`/`advertised_models` parse? Extend those two
   functions; nothing else changes.
3. Harness-specific ability worth first-class UI? Add a capability flag to
   `AgentCapabilitySummary` (serde-default false), gate the UI on it, add the
   `ProviderRuntime` dispatch arm with an `unsupported` backstop for
   everyone else.
4. Full native adapter? Mirror codex.rs/claude.rs: a runtime module owning
   the process + a `ProviderRuntime` variant + ingestion into
   `push_conversation_item`. Budget accordingly; tier 1 covers more than you
   think.

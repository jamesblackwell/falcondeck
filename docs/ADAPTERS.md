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

## Prior art (surveyed 2026-08-07)

We surveyed vibe-kanban, Crystal→Nimbalyst, claude-squad, OpenHands, Goose,
and Zed/ACP. Verdict: FalconDeck's shape — normalized item enum + one dispatch
seam + capability-gated UI + ACP as the generic tier — matches where the
field converged, with two of our choices ahead of it (open provider ids,
which vibe-kanban paid three schema migrations for closing; and ACP-native
generic agents, where OpenHands' bolted-on ACP path renders second-class).
Borrowed ideas, in adoption order:

1. **Normalize tool calls by intent, not name** (vibe-kanban's `ActionType`):
   `FileEdit{unified_diff}` / `FileRead` / `CommandRun{category}` / `Search` /
   … with a `Tool{name,args}` escape hatch, so Claude's `Edit`, Codex's
   `apply_patch`, and ACP `fs/write_text_file` hit ONE diff renderer. The
   shell-command intent classifier (bash → read/search/edit/fetch, unwrapping
   `bash -c`) shipped 2026-08-07 into `ToolCallDisplay.activity_kind`; the
   full `ActionType` item schema rides the Phase 0 typegen change.
2. **Approvals as a status on the tool call**, not a side channel — Zed,
   vibe-kanban, and Nimbalyst converged on this independently; it is also
   what makes approvals replayable on mobile reconnect. Embed the tool-call
   view in the request (ACP does); keep option ids free-form over a closed
   `kind` enum.
3. **Stream items as RFC-6902 patches** with vibe-kanban's `fix_patch_ops`
   (rewrite add↔replace against a sent-paths set) — one mechanism for
   streaming text, late tool results, and relay reconnect, no separate
   snapshot-vs-delta protocol.
4. **Capabilities-as-data over capability flags**: keep flags only for what
   changes UI *shape*; model/mode/setting *choices* stream as data (ACP's
   `SessionConfigOption` is the general form — one generic picker renders
   any provider's settings). With open provider ids we can't enumerate flags
   ahead of time, so this matters more for us than for anyone surveyed.
5. **Forward-compat serde hygiene** (ACP's recipe): `#[serde(other)]`
   catch-alls, default-on-error optionals, skip-invalid array items, `_meta`
   as the typed escape valve. Do at typegen time.
6. **Store raw provider output + replayable projection** (Nimbalyst):
   parser fixes re-derive history instead of corrupting it. Belongs to the
   SQLite system-of-record work. Two traps they hit that we will too:
   tool-call pairing across streaming batches/resume, and Codex reusing
   short item ids across sessions (synthetic composite ids).
7. **Thinking UX** (Zed, verbatim): `Auto | Preview | AlwaysExpanded |
   AlwaysCollapsed`, Auto expands the streaming thought then auto-collapses
   unless user-toggled, Preview height-caps with a fade; expansion state
   keyed by item id, never list index. Presentation defaults across all
   five products: collapsed by default, expanded only for what needs a
   decision, one global setting.
8. **Protocol inspector** (Zed's acp_tools): an in-app incoming/outgoing
   log with request↔response correlation pays for itself the first time a
   provider misbehaves across daemon + relay + three clients.

Anti-patterns confirmed by the survey: routing the generic tier around your
own renderer registry (OpenHands' ACP events get no diffs/grouping/
confirmations); matching agent behavior on English strings (claude-squad's
state machine breaks on a copy change); building the plugin registry before
the second real integration (Crystal's dead `CliToolRegistry`).

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

## Pi

Pi uses the generic ACP tier through the maintained `pi-acp` adapter, which
bridges ACP to Pi's native `pi --mode rpc` interface. Install both commands on
the daemon host:

```sh
npm install -g --ignore-scripts @earendil-works/pi-coding-agent pi-acp
```

Then choose **Settings → Agents → Recommended → Configure Pi**. This writes the
equivalent of:

```json
{
  "providers": {
    "pi": {
      "label": "Pi",
      "command": ["pi-acp"]
    }
  }
}
```

Pi owns its authentication, model-provider configuration, extensions, skills,
and persisted sessions. FalconDeck owns the client connection, normalized
conversation stream, remote transport, and capability-gated presentation. Keep
Pi on the ACP path unless a concrete Pi feature proves impossible to represent
there; do not add a `ProviderRuntime::Pi` branch merely to make the provider
look built in.

## OpenCode

OpenCode ships its own ACP server, so it needs no third-party bridge. Choose
**Settings → Agents → Recommended → Configure OpenCode**, which writes:

```json
{
  "providers": {
    "opencode": {
      "label": "OpenCode",
      "command": ["opencode", "acp"]
    }
  }
}
```

FalconDeck also searches OpenCode's install-script location
(`~/.opencode/bin`) when launched as a desktop app, where the interactive shell
PATH is often unavailable. Packaged macOS builds also import the interactive
login-shell environment for ACP subprocesses, so provider credentials supplied
through variables such as `OPENROUTER_API_KEY` behave the same in FalconDeck as
they do in OpenCode's terminal UI. Explicit `providers.json` environment values
still win. The ACP integration covers streamed text and
reasoning, tool calls and diffs, permission requests, images, interruption,
MCP servers, model/config discovery, and persisted session reload. OpenCode
continues to own its agents, permissions, project rules, tools, formatters,
linters, and provider authentication.

### Native transport rollout and ACP fallback

FalconDeck keeps the generic ACP adapter for OpenCode and every other ACP
harness. The native OpenCode server is a separate transport that unlocks
native session hydration and mid-turn `delivery: "steer"`; ACP remains a
permanent fallback.

An OpenCode entry can declare a transport:

```json
{
  "providers": {
    "opencode": {
      "label": "OpenCode",
      "command": ["opencode", "acp"],
      "transport": "acp"
    }
  }
}
```

`auto` tries the native server for each new thread and falls back to ACP if
startup, session creation, or the read/permission/question compatibility probe
fails. `native` requires that probe to succeed. `acp` always uses the generic
adapter. A thread is pinned to the transport that created it: FalconDeck never
switches an active turn, and never blindly resends an input after an ambiguous
native admission.

Native turns currently project authoritative text, reasoning, tool, permission,
and question records from OpenCode's session APIs. Text and tool records may
arrive at FalconDeck in larger completed blocks than they do over ACP. Use the
Agents settings panel's **Use ACP** action if that tradeoff or a particular
OpenCode release proves unreliable; the change applies to new threads and does
not mutate existing sessions.

When a workspace attaches, the native path loads OpenCode's provider model
catalog and its visible primary agents. The composer therefore exposes native
model selection plus OpenCode modes such as **Build** and **Plan**. The
permission picker offers **Ask to approve** and **Always approve**. The latter
answers each request for that thread with OpenCode's one-time approval; it does
not persist a global OpenCode permission rule. OpenCode has no matching
per-session filesystem sandbox setting, so FalconDeck hides the sandbox picker
for native threads instead of displaying a disabled or misleading control.

The native server is started on `127.0.0.1` with a unique generated password,
rather than exposing an unauthenticated listener. If native mode proves
unstable in practice, select `acp`; that route remains supported and covered by
the ACP conformance suite.

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
fails — or if the thread's model cannot execute natively. OpenCode 1.18's v2
runner resolves models only against its own registry (`GET /api/model`), which
is a strict subset of the configured catalog in two independent ways
(both verified live on 1.18.18):

* **Providers.** API-key providers (deepinfra, openrouter, OpenCode Zen) are
  registered; OAuth and coding-plan credentials (`zai-coding-plan`, ChatGPT,
  the Gemini plugin) are v1-only and never appear.
* **Model APIs.** Among the registered models the runner implements only
  `aisdk:@ai-sdk/openai-compatible` and `aisdk:@ai-sdk/anthropic` — in
  practice, OpenCode Zen's models. Everything else, including every openrouter
  model (`@openrouter/ai-sdk-provider`) and every deepinfra model
  (`@ai-sdk/deepinfra`), fails with `SessionRunnerModel.UnsupportedApiError`.
  Nothing OpenCode serves enumerates this set, so `RUNNER_MODEL_APIS` in
  `crates/falcondeck-daemon/src/opencode.rs` is an allowlist; it fails toward
  ACP, which runs everything the v1 catalog lists.

A model the runner cannot resolve is admitted by `/api/session/{id}/prompt` and
then dies in `SessionRunnerModel.resolve` with no session event and no
assistant record — only a server log line — so FalconDeck checks the session's
effective model against the registry before pinning a thread to the native
transport, and again before every native prompt admission (the model can change
mid-thread). The registry loads asynchronously for roughly a second after
server startup and reads as empty until then, so an empty answer is retried
before it is believed. A session without an explicit model always passes the
gate: the v2 runner resolves its default inside its own registry.

The same registry settles reasoning efforts. OpenCode calls them *variants* and
the two catalogs disagree: `/config/providers` advertises low/medium/high for
`openrouter/google/gemini-3.7-flash` while `/api/model` lists none for it, and
sending a variant the runner does not know kills the turn after admission with
`SessionRunnerModel.VariantUnavailableError`. A native turn therefore sends an
effort only when the runner registry lists it, and otherwise lets the model run
at its own default; the picker keeps offering the v1 catalog's efforts because
the ACP transport does honour them. `native` surfaces the gate's reason as the
thread-creation error instead of falling back; `acp` always uses the generic
adapter. A thread is pinned to the transport that created it: FalconDeck never
switches an active turn, and never blindly resends an input after an ambiguous
native admission.

Native turns currently project authoritative text, reasoning, tool, permission,
and question records from OpenCode's session APIs. Text and tool records may
arrive at FalconDeck in larger completed blocks than they do over ACP. Use the
Agents settings panel's **Use ACP** action if that tradeoff or a particular
OpenCode release proves unreliable; the change applies to new threads and does
not mutate existing sessions.

For a repeatable live check through the same daemon HTTP path as the desktop
app, run `make qa-opencode`. The smoke test uses an isolated FalconDeck state
directory, inherits the user's normal OpenCode authentication, connects the
current repository as a workspace, creates an OpenCode thread, sends one turn,
and prints the selected transport, native session id, terminal status, error,
and assistant output as JSON. Override the defaults with, for example,
`make qa-opencode OPENCODE_TRANSPORT=native OPENCODE_MODEL=openrouter/google/gemini-3.7-flash`.
The command makes one small real model request when execution reaches a working
provider, so it is intentionally not part of the ordinary automated test suite.

ACP stdout is JSONL, but OpenCode 1.18 can prepend Warp `OSC 777` terminal
notifications to a JSON-RPC object on the same physical line. FalconDeck strips
only complete leading OSC records before decoding the attached JSON. Arbitrary
non-JSON output and control bytes inside a JSON payload are not rewritten. The
shared ACP conformance probe uses the same decoder, so `cargo run -p
falcondeck-daemon --example acp_conformance -- --live -- opencode acp` checks
this exact wire behavior outside the desktop app.

OpenCode 1.18 advertises `session.wait` but can return a 503 response saying the
service is not available yet. FalconDeck therefore detects turn completion from
the implemented active-session endpoint and the admitted message's terminal
state. The native compatibility probe includes that endpoint, so `auto` falls
back to ACP before admitting a turn when an OpenCode release lacks it. Native
prompt admission explicitly sets `resume: true`; without it, OpenCode only
admits the input. Prompt message ids are globally unique across OpenCode's
durable store — reusing one returns a `ConflictError` even in a different
session — which the daemon's per-turn UUIDs already satisfy. The probe also
validates the endpoints and prompt request fields against the server's own
`/doc` OpenAPI document, so a build that rejects any part of the native request
shape falls back to ACP before a thread is pinned to the native transport.
A turn that reaches the runner with a model the registry cannot resolve is the
one failure mode neither check can catch after admission; the runner-registry
gate above exists to make that state unreachable, and the turn error still
carries the server's own logged cause if it ever occurs.

Two further 1.18 quirks are handled: message pagination continues with
`cursor.next` toward older items (`cursor.previous` points toward newer items
and is empty at the head of a newest-first listing), and session deletion uses
the v1 `DELETE /session/{id}` route because the v2 API has no delete. While a
turn runs, FalconDeck also subscribes to the session's durable event stream,
scoped with `after` to the prompt's admission sequence so prior turns' events
cannot replay into the wait: `session.next.step.*` events prove the drain is
executing (so a slow first model token cannot trip a timeout while the session
is absent from the active map) and `session.next.step.failed` surfaces the
provider's own error text. Completion itself is detected from the projected
terminal assistant message together with the active map, with polling as the
fallback when the stream cannot be established. A turn that fails before its
first model call produces no assistant message and no error record anywhere in
the session API, so after such a turn the waiter reports that case explicitly
rather than a generic timeout; while a permission or question is pending, the
waiter treats the session as active regardless of the active map.

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

### Keeping up with OpenCode releases

The v2 API is experimental and moves quickly. FalconDeck's posture is that an
upstream change should cost native features, never correctness: every request
shape the native transport sends is declared in the `CONTRACT_*` tables in
`crates/falcondeck-daemon/src/opencode.rs`, validated at attach against the
server's own `/doc`, and any mismatch routes new threads to ACP. The
runner-registry gate is dynamic where OpenCode allows it — membership comes
from `/api/model` live, so the day the v2 runner learns to execute OAuth or
coding-plan credentials, those models start running natively with no FalconDeck
change. The model-API allowlist is the one part that cannot be read from the
server; a release that implements a new API needs that constant extended.

When a new OpenCode version lands, run this checklist before trusting it:

1. `cargo run -p falcondeck-daemon --example opencode_conformance` from a real
   project directory (agents are project-scoped; add `--live` for the one
   check that spends tokens).
2. The `make qa-opencode` matrix: default `auto`, then
   `OPENCODE_TRANSPORT=native` and `OPENCODE_MODEL=<a coding-plan model>` to
   confirm both the native path and the gate's refusal still behave.
3. Diff the API surface against the previous release:
   `curl -su opencode:$PW http://127.0.0.1:$PORT/doc | jq -S .` piped to a
   file, compared with the same capture from the prior version. Changes that
   touch the `CONTRACT_*` tables are breakage; new surface is opportunity.

Opportunities to watch for in that diff, each currently worked around:
`session.wait` returning something other than 503 (replaces active-map
polling), a v2 session delete (replaces the v1 route), OAuth providers
appearing in `/api/model` (retires the ACP-only restriction for those models),
and the runner accepting further model APIs (widen `RUNNER_MODEL_APIS`; probe
by prompting one model per API and reading the server error log). When adding a new request field or endpoint to the transport, add it
to the `CONTRACT_*` tables in the same change — an assumption that is not in
those tables is one the attach-time check cannot defend.

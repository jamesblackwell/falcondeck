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
industry's common denominator (Zed's protocol; spoken by OpenCode, Goose,
Grok…), so most new harnesses arrive with an ACP mode. Native
adapters are reserved for harnesses whose extra surface earns the maintenance
(today: Codex, Claude, and Antigravity).

## Hermes through native ACP

The supported baseline is Hermes source `1d6b278`, ACP SDK 0.9.0 / protocol 1.
See [live qualification](HERMES-ACP-QUALIFICATION.md). Hermes uses the generic
model/mode catalogs, transcript items and interactive requests on every client.
No Hermes selector or permission UI branch is needed. The mobile composer
exposes native session modes through its existing option sheet and hides a
reasoning picker when the selected model has no reasoning inventory.

Hermes-specific admission, error handling, session loading and connector
isolation remain in the ACP runtime/ingestion boundary. Each thread owns an ACP
process so upstream MCP registration cannot bind a sibling thread's capabilities.
Native Hermes storage owns history; daemon restart reloads the same ACP handle.
Replay pruning triggers an authoritative daemon sync and selected-thread detail
read on paired clients, including pending permission requests.

Standard ACP permission diffs enter the existing file-change projection before
the request banner. Remembered diffs survive partial tool updates and settle on
completion, denial or interruption. Exact approval option IDs pass through both
remote RPC and queued actions; their shared parser must accept every structured
response variant the core protocol exposes. This integration adds no RPC method,
capability field, conversation database or Hermes configuration store.

The qualified build advertises images and passes a controlled vision prompt.
Usage is displayed only when emitted. Native gateway control, managed updates,
HTTP/SSE MCP, delegation cancellation, and a FalconDeck Hermes skills picker
remain outside the qualified surface. The separate
[gateway qualification](HERMES-GATEWAY-QUALIFICATION.md) records working native
interactions and the connector/history blockers that prevent a production
transport switch.

## The seams, and the invariants that keep them clean

1. **`ProviderRuntime` (app/provider_runtime.rs)** — the ONLY place codex /
   claude / agy are recognized by name for routing. Six operations dispatch
   through it. Invariant: never compare `provider == CODEX/CLAUDE/AGY` at a
   call site to choose behavior; either dispatch through the seam or gate on
   a capability.
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
7. **Warm-runtime retirement (app/runtime_health.rs)** — every provider that
   keeps a process alive between turns retires it on one timer per runtime:
   wait out a warm grace period, stop the process only when no thread for
   that provider is running, waiting, queued or dispatching. Codex 5 min, ACP
   20 min, native OpenCode 10 min, and 2 min for any runtime started only to
   answer the composer's catalog hydration. Claude and agy spawn a CLI per
   turn and own no timer. Invariant: a warm runtime that nothing can stop is
   a leak — a new long-lived provider process gets a timer in the same commit
   that introduces it. Retirement takes `AcpRuntime::retirement_guard`
   exclusively so it can never kill a process a caller has already resolved;
   an ACP agent that holds sessions without negotiating `loadSession` opts
   out, because it would come back having forgotten the conversation.

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

## Antigravity CLI (`agy`)

Antigravity has no ACP server. FalconDeck drives it the same way it drives
Claude: a native `ProviderRuntime::Agy` backend that spawns `agy` per turn
with `--input-format stream-json` / `--output-format stream-json`, resumes
with `--conversation`, and steers by writing another
`{"event":"user","message":{"content":[…]}}` line to stdin.

Headless print mode cannot show interactive permission prompts. Tools that
would ask are soft-denied unless the thread's permission mode is
`bypassPermissions` (`--dangerously-skip-permissions`) or the user has
allow-rules in `~/.gemini/antigravity-cli/settings.json`. MCP servers are
owned by Antigravity (`~/.gemini/config/mcp_config.json`); FalconDeck does
not inject connectors into that file.

Install: `curl -fsSL https://antigravity.google/cli/install.sh | bash`.
Auth: run `agy` once in a terminal and complete Google sign-in.

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

### OpenCode 2 native transport and ACP fallback

The native transport targets the [released OpenCode 2 API](https://opencode.ai/v2/docs/api/).
OpenCode **2.0.29** is qualified as of 2026-10-15. It supports native session
hydration, model and reasoning-variant selection, Build/Plan modes, mid-turn
`delivery: "steer"`, tools, permissions, forms, interruption, and reload.
OpenCode continues to own the session and its history; FalconDeck retains the
same native session ID across restarts and never substitutes an ACP session
for an existing native thread.

An OpenCode entry can declare a transport:

```json
{
  "providers": {
    "opencode": {
      "label": "OpenCode",
      "command": ["opencode", "acp"],
      "transport": "auto"
    }
  }
}
```

`auto` tries native for each new thread. Before pinning it, FalconDeck checks
`/openapi.json`, creates an idle session, reads messages/permissions/forms,
checks its effective model, and calls the implemented experimental idle wait.
An incompatible build falls back to ACP before any prompt is sent. Explicit
`native` reports the failure; `acp` skips native probing. These settings apply
to new threads. OpenCode 1.x uses ACP because its preview native API differs.

The private server binds to `127.0.0.1`, uses a generated password that overrides
inherited password variables, and receives workspace-specific MCP configuration.
FalconDeck owns the server process group and terminates its helpers on cleanup.
The shared background service is not used: adopting it requires separate work
on workspace configuration, credentials, and process ownership.

### Admission, execution, and history

Prompt fields are flattened (`id`, `text`, `files`, `delivery`, `resume`).
FalconDeck sets `resume: true`, verifies the returned message and session IDs,
and never falls back or automatically resends after an ambiguous admission.
Persisted queued requests derive a stable native message ID from their queue
ID so a dispatch retry cannot duplicate admission. A failed steer retains its
ID for a retry with the same payload. A different payload receives a new ID:
OpenCode's idempotency rule is **first admission wins**, without comparing the
payload. Concurrent retries must therefore preserve both ID and content.

Completion uses `/api/experimental/session/{sessionID}/wait`, which waits for
the entire foreground drain, including steered successors. The terminal verdict
comes from the durable `idle` record after the admitted message. Final output
is projected before interpreting that verdict. Failed and interrupted outcomes
stay errors; an intermediate tool response or absence from
the active map cannot finish a turn. The monitor polls authoritative message,
permission, and form APIs while waiting. Text can arrive in larger blocks than
it does through ACP.

History walks `cursor.next` toward older messages until every page is read.
Assistant content without its own ID receives a stable ID from its message,
type, and position so text and reasoning blocks cannot overwrite one another.
Agent timestamps and stored image/file bytes survive hydration, including
attachment-only user messages. Selected skills use explicit file/name
preambles because `$skill` text alone no longer expands in V2; those preambles
are removed from the displayed user text during reload. Session deletion uses
`DELETE /api/session/{sessionID}`.

### Models and interactive requests

The flat `/api/model` catalog is the runner registry. Enabled membership and
variants are read again before each prompt, so provider hot reloads are checked
against current state. The old preview model-API allowlist is removed; any
enabled model can run. Missing explicit models resolve through OpenCode's
configured default, while agent-specific models are preserved. Selecting
**OpenCode default** again restores the configured model rather than retaining
the last explicit choice. Reasoning presets are sent only when the
live model registry publishes them; the effort picker's **default** entry uses
base model settings rather than silently choosing the lowest preset.

Permission replies use `decision: "once" | "always" | "reject"`. **Always
approve** in FalconDeck sends one-time approvals for that thread and does not
persist a global OpenCode rule. Native threads hide the filesystem sandbox
picker because OpenCode has no matching per-session control.

Questions use V2 forms. FalconDeck reads the authoritative form before replying,
maps stable field keys and option labels to typed values, applies hidden
defaults and conditions, and keeps a rejected reply pending for correction.
Strings, numbers, integers, booleans, multiselect, and external confirmation are
supported. The shared question UI presents visible fields in order; multiselect
accepts comma/newline-separated labels, and conditional fields are filtered when
converting the reply rather than dynamically hidden in the UI.

### Qualification and upgrades

Run the cost-free native checks from a real project (agents are project-scoped):

```sh
cargo run -p falcondeck-daemon --example opencode_conformance
cargo run -p falcondeck-daemon --example opencode_conformance -- --live
make qa-opencode OPENCODE_TRANSPORT=native OPENCODE_MODEL=openrouter/openai/gpt-5.6-luna
```

The first command verifies authentication, the schema, model discovery, idle
wait, permission allow/deny, typed forms, and a durable invalid-model error.
`--live` additionally qualifies a real reply, model variant, foreground tool,
steering with repeated-ID deduplication, interruption, more than 200 messages
of history, and reload through a fresh private server. The daemon smoke uses
isolated FalconDeck state with the user's normal OpenCode credentials.
Qualification also exercised real question and permission requests through the
daemon, followed by a forced daemon restart, history hydration, and continuation
with the same native session ID. Graceful standalone daemon exit has a separate
thread-search indexing delay after native server cleanup completes.

The ACP path remains covered by its conformance suite, including cancellation,
process restart, reload, tools, and MCP discovery. Its JSONL decoder strips only
complete leading Warp OSC terminal records before parsing a JSON-RPC object.

Upgrade with `opencode upgrade` within the installed major. A migration from
1.x requires `opencode upgrade --major` and a backup of the binary and config.
Supported V1 configuration is normalized in memory, but **V1 plugins do not run
in V2**, including plugins discovered in `~/.config/opencode/plugins`. A legacy
plugin can block location activation. Disable or port it before retrying; see
the [upstream migration guide](https://opencode.ai/v2/docs/migrate-v1/).

When upgrading, rerun native and ACP conformance plus the daemon smoke in `auto`
and `native` modes. Compare `/openapi.json` with the previous release, and add
new transport assumptions to the `CONTRACT_*` tables in `opencode.rs`. The idle
wait remains experimental even though the rest of this integration uses the
released API. Inbox editing, session fork/move, background-tool controls, and
nested Code Mode tool attribution remain separate opportunities.

## Cursor

Cursor's agent CLI (`cursor-agent`) ships a built-in ACP server behind its
`acp` subcommand, so it rides the generic ACP tier. Current docs call the
binary `agent`; FalconDeck always launches `cursor-agent`, because `agent` is
also Grok's install name. Install and authenticate per Cursor's docs
(`curl -fsSL https://cursor.com/install | bash`, then `cursor-agent login`;
verify with `cursor-agent status`). The harness upgrade command restores any
pre-existing non-Cursor `~/.local/bin/agent` symlink after the official
installer rewrites it.

Then choose **Settings → Agents → Recommended → Configure Cursor**, which
writes the equivalent of:

```json
{
  "providers": {
    "cursor": {
      "label": "Cursor",
      "command": ["cursor-agent", "acp"]
    }
  }
}
```

Current Cursor (2026.08+) negotiates protocol 1 with `loadSession`, image
prompts, HTTP/SSE MCP, and `cursor_login`. FalconDeck completes
`authenticate` with `cursor_login` after `initialize` (it reuses `agent
login` credentials; it does not open a browser). `session/new` advertises
modes (`agent` / `plan` / `ask`) and a parameterized model catalog
(`composer-2.5[fast=true]`, `default[]`, …). Those ACP ids win; older builds
that publish no catalog still fall back to `cursor-agent --list-models`
(`auto`, `composer-2.5-fast`, `gpt-5.6-sol-medium`). Session model selection
uses `session/set_config_option` / `session/set_model`. Failures there are
non-fatal. **Known limitation:** some Cursor builds ignored ACP model
switching and only honored `--model` at spawn; on those builds a picker
selection is logged as a warning and the turn runs the CLI default.

Cursor does not publish a permission `configOption`. The CLI's `--force` /
`--yolo` / `--auto-review` flags are not available on `cursor-agent acp`.
FalconDeck therefore seeds the composer Permissions picker with
`always-approve` (the default) and `default` (Ask to approve). The daemon
auto-answers `session/request_permission` when the thread is on
`always-approve`. Agent / Plan / Ask remain the Mode picker
(`session/set_mode`).

Cursor also sends vendor reverse RPCs. FalconDeck maps `cursor/create_plan`
onto the existing plan-review banner and `cursor/ask_question` onto the
question banner. Notification methods (`cursor/update_todos`, `cursor/task`,
`cursor/generate_image`) are acknowledged so they cannot stall a turn.

The 2025 beta (`cursor-agent --version` prints a bare commit hash) has no
`acp` subcommand and cannot be used as a FalconDeck provider. Upgrade it
before configuring Cursor.

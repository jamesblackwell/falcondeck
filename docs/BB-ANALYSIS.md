# bb (get-bb/bb) — Architecture Analysis

Analysis date: 2026-08-07. Source: github.com/get-bb/bb @ HEAD (shallow clone).

bb is "an agentic IDE that can control itself" — the same problem space as
FalconDeck: orchestrate multiple coding-agent CLIs behind one UI. It is worth
studying because it is roughly one architectural generation ahead of us on
three axes: the provider bridge model, the self-control surface, and — most
relevant to us — a shipping plugin system where 13 first-party features are
themselves plugins.

## 1. Core architecture

Four runtime pieces, two hard contract boundaries:

- **Server** — the hub. SQLite is the single source of truth; the server is
  stateless over it. HTTP API + WebSocket notifications.
- **Host daemon** — one per enrolled machine. Provisions workspaces, runs
  provider processes, posts event batches back. Multi-host is first-class:
  one project can have sources on several machines.
- **App / CLI** — equal clients of the same server contract. The CLI is
  explicitly "for both users and agents".
- Contracts: `@bb/server-contract` (client↔server) and
  `@bb/host-daemon-contract` (server↔daemon). Implementation packages never
  import across them.

Their thread model has two notions we lack: **manager threads** (coordinate
child threads — delegation is a first-class data-model concept, not a
convention) and **environments** (a workspace×host binding with managed
lifecycle/cleanup, shareable across threads).

## 2. How bb handles multiple agents

Providers: `codex`, `claude-code`, `pi`, `acp-cursor` — with an `acp-` prefix
convention for ACP-bridged providers (same conclusion our PROVIDERS.md reached
independently).

The key design difference from us: **`ProviderAdapter` is a pure translation
layer, not a process owner** (`packages/agent-runtime/src/provider-adapter.ts`).
The runtime owns process lifecycle and transport; an adapter only:

- declares `process: { command, args, env }` to spawn,
- `buildCommandPlan()` — translates abstract commands (start thread, turn,
  interrupt…) into provider requests, or a typed no-op with a reason,
- `translateEvent()` — provider notifications → normalized `ThreadEvent[]`,
- `translateAcceptedCommand()` — synthesizes events for protocol gaps (e.g. a
  provider that never echoes the user message),
- `decodeToolCallRequest` / `decodeInteractiveRequest` /
  `buildInteractiveResponse` — approvals normalization,
- `buildThreadDetachedEvents()` — reconciliation events when the process dies
  (open tool calls settled as interrupted), so the UI can't strand spinners.

**Claude is driven via the Claude Agent SDK inside a Node "bridge" process**
(`agent-runtime/src/claude-code/bridge/`), not `claude -p` spawn-per-turn like
ours. Consequences worth envying: persistent sessions (no kill-and-resume per
turn), native mid-session capability, and `tool-proxy-mcp.ts` — plugin tools
are exposed to Claude as an in-process MCP server. Codex uses app-server like
us. Capabilities are split into wire-facing `ProviderCapabilities` (clients
read) vs `ProviderServerCapabilities` (backend-only policy answers) — a
refinement of our single `AgentCapabilitySummary`.

## 3. The plugin architecture (the interesting part)

Plugins are the product's own composition mechanism: tasks, automations,
workflows, memory, secrets, github, side-chat, docs, custom-instructions,
ask-user-question, inline-vis, connect, t3sidebar are ALL plugins in
`plugins/`. The core app is a shell.

**Shape**: a plugin = `server.ts` (backend factory) + `app.tsx` (frontend) +
optional `skills/` + assets, built by `bb plugin build` against a versioned
SDK (`@bb/plugin-sdk`, semver-gated by `PLUGIN_SDK_MAJOR`).

**Trust model**: deliberately NOT sandboxed. Backend plugins load in-process
into the Node server (via jiti, with a URL-generation trick so hot reload
actually replaces modules). Frontend contributions are React components and
"content scripts" documented as "trusted same-origin page code, not a
sandbox". Trust is handled at install time (official registry bundled with the
app, `npm:`/`path:`/`builtin:` install sources), not at runtime. This is the
pragmatic choice that makes deep integration possible.

**Backend surface** (`BbPluginApi`, backend-contract.ts — ~700 lines):

| Facet | What a plugin gets |
|---|---|
| `settings` | declarative settings descriptors, host-rendered UI |
| `storage` | namespaced KV + a real per-plugin SQLite database |
| `http` / `rpc` | routes under `/api/v1/plugins/<id>/…`, auth modes |
| `realtime` | push to connected frontends |
| `background` | long-lived services + cron schedules |
| `cli` | a `bb <plugin> …` subcommand — agents call plugins via CLI |
| `agents` | per-turn context injection + **`registerTool()`** — native tools with zod schemas executed in the plugin, delivered to agents (MCP-proxied for Claude) |
| `ui` | host-rendered UI contributions |
| `events` | thread lifecycle listeners |
| `sdk` | the FULL bb SDK bound over loopback — plugins can spawn threads, steer, read everything (spawned threads are attributed `origin: "plugin"`) |
| `hosts` | server→daemon control-plane declarations |
| `onDispose` | LIFO cleanup for reload/disable |

**Frontend surface** (app-contract.ts — ~1300 lines) — named slots, not a
free-for-all: `homepageSection`, `settingsSection`, `navPanel`,
`threadPanelAction`, `pendingInteraction`, `sidebarFooterAction`,
`fileOpener`, `messageDirective`, `messageAction`, composer customization
(actions, banners, plus-menu rows, rich-text rules), and two experimental
whole-region replacements (`experimental_threadList` replaces the sidebar
thread list wholesale — that's how `t3sidebar` reskins the app). Mention
providers add `@`/`#`/`$`-style completions. Content scripts cover the
"enhance without a slot" gap with strict generation-based mount/dispose.

**Quality machinery we should copy regardless of scope**: a fake-host test
harness (`@bb/plugin-sdk/testing`) so plugin authors get deterministic
backend + jsdom frontend tests; failure containment (a throwing provider
"fails closed for this plugin only", tool-count caps, output truncation);
explicit hot-reload semantics (settings/KV/DB survive, old API invalidated
only after the replacement factory succeeds).

**Dogfooding**: `plugins/tasks/WORKERS.md` is a prompt file for bb agents
building bb plugins in shared worktrees — the "controls itself" claim is their
actual development process.

### Deep-dive findings (agent layer)

- **Codegen'd protocol**: the entire Codex app-server schema is generated from
  the binary (`codex app-server generate-ts`) and vendored — no hand-written
  protocol drift. We hand-wrote ours; `codex app-server generate-json-schema`
  exists and we already used it once for the audit. Automate it.
- **Visibility/coverage layer**: every raw provider event is classified
  `normalized | noise | unknown`; only `unknown` emits a first-class
  `provider/unhandled` event carrying the raw envelope. "Did we handle the new
  event type?" becomes a test assertion instead of a bug report.
- **Normalized error categories**: a 19-value enum (context-window, billing,
  rate-limit, sandbox, unauthorized…) so retry/UI logic is provider-agnostic.
- **Thread-identity stamping**: adapters emit a branded `UNSTAMPED_THREAD_ID`
  and the runtime resolves bb-id↔provider-id in one place, dropping
  unresolvable events instead of misattributing them. Plus a turn-replay
  filter (providers replay finished turns on reconnect) and scoped item ids
  (`parent-tool-call:scope`) so subagent output can't merge into the main
  message.
- **Claude session model**: ONE Agent SDK `query()` in streaming-input mode
  spans many turns; "stale-resume recovery" transparently swaps in a
  replacement session resumed on the captured id when the stream dies.
- **Idle session reaping + auto-restart**: idle provider processes are stopped
  without losing thread state (resume on next turn); rate-limit/auth errors
  trigger a process restart + re-resume — account switching without losing
  the thread.
- **Self-control = CLI, not injected tools**: threads get `BB_THREAD_ID`,
  `BB_SERVER_URL`, `BB_CLI` etc. in their shell env, instructions appended per
  turn, and a playbook skill; every command takes `--json`. Orchestration is
  parent/child threads (`bb thread spawn --parent-self`, `tell`, `wait`), with
  child outcomes batched into the parent. Cross-provider "handoff" is NOT
  in-place — providerId is immutable; handoff seeds a new thread with the same
  environment. The README's "dispatch panel"/"task board" exist only as a
  screenshot; the task board is a plugin.
- **Permission ceiling**: permission modes are rank-ordered and each host
  stores a privilege ceiling applied as a last-mile clamp before every turn.
- **`composerActions` as provider data**: providers declare their composer
  affordances (`/plan`, goals, skills triggers) as catalog data; the composer
  builds its typeahead from that — no per-provider UI branches.

## 4. What this means for FalconDeck

Two separable takeaways.

### 4a. Provider layer (cheap, high value)

- Adopt the **pure-translation adapter** split when we do PROVIDERS.md
  Phase 1 properly: runtime owns processes, adapters translate. Our ACP
  runtime already leans this way; claude.rs/codex.rs don't.
- Seriously evaluate **Claude-via-Agent-SDK in a bridge process** to replace
  spawn-per-turn `claude -p`: persistent sessions, streaming input, and the
  MCP tool-proxy trick would let future FalconDeck plugins/tools reach Claude
  natively. This is the single biggest mechanical upgrade available to us.
- Add `buildThreadDetachedEvents`-style reconciliation so a dead provider
  process can never strand running tool calls in the UI.

### 4b. A FalconDeck plugin system

> **Status: documented idea, deliberately not scheduled (2026-08-07).** Core
> functionality (remote hosts, provider polish) comes first. Revisit once the
> remote-host work settles.

bb proves the model works, and its choices map onto our architecture
surprisingly well because we share the daemon/clients split:

- **Backend plugins → the Rust daemon problem.** We cannot load user code
  in-process like their Node server. Two honest options:
  1. **Node/Deno plugin host sidecar**: the daemon spawns one plugin-host
     process that loads JS/TS plugins and speaks a versioned JSON-RPC contract
     back to the daemon (register RPC routes, tools, cron, thread-event
     subscriptions). Closest to bb's power; one new moving part.
  2. **Everything-is-ACP/MCP**: plugins are just MCP servers + declarative
     manifest. Weakest integration; already half-exists in the ecosystem.
  Recommendation: option 1, with the contract designed so simple plugins are
  a single TS file, exactly like bb's `server.ts` factory.
- **Frontend plugins → named slots in chat-ui.** Our shared `packages/chat-ui`
  is the natural slot host, and every surface (desktop, remote-web) gets
  contributions for free. Start with the slots we already have natural seams
  for: composer footer actions, thread context-menu items, session-header
  actions, sidebar sections, settings sections, message actions. Load plugin
  UI bundles from the daemon (`/api/plugins/<id>/app.js`) — remote-web makes
  this trivially web-distributable; the Tauri webview loads the same bundle.
- **Agent-facing plugins**: `registerTool` equivalents flow through what we
  already have — Codex/Claude get them via MCP config injection (and via the
  SDK bridge if we adopt it); ACP providers via the session config. A
  `falcondeck` CLI for agents (bb's `bb` CLI pattern) is the lowest-tech,
  provider-agnostic path and worth doing first.
- **Trust**: follow bb — trusted plugins, install-time consent (path installs
  for development, a curated list for distribution), no runtime sandbox
  pretense. Mobile stays a consumer of plugin *data* (server-rendered lists,
  settings), not plugin code, for now.

Suggested phasing: (1) daemon plugin-host sidecar + settings/storage/RPC/CLI
facets, one proof plugin; (2) chat-ui slots + plugin bundle serving;
(3) agent tools via MCP injection; (4) hot reload + test harness + docs.

## 5. Things NOT to copy

- Their SQLite-as-source-of-truth server would be a rewrite of our daemon's
  in-memory + JSON persistence model — not worth it until multi-host matters.
- Electron shell (we're Tauri; keep it).
- 34 workspace packages of contract ceremony is right for their team-size
  ambitions but would slow us down today; two contracts (daemon API, plugin
  SDK) suffice.

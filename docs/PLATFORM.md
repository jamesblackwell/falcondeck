# FalconDeck as a Platform

Product and architecture direction for taking FalconDeck from "agent IDE" to an
extensible, model-agnostic orchestration layer. Written 2026-08-07 after an
extensibility audit of the whole codebase; file references below are to that
day's tree.

## 1. What FalconDeck actually is

Calling it an IDE undersells it and points the roadmap at the wrong competitors.
The honest description:

> **FalconDeck is the workspace where a small team and its agents work
> together — from any device, live.**

The target user is a solopreneur or small team building an agentic company:
people who treat agents as staff, not autocomplete. For them the scarce thing is
not another agent harness — Codex, Claude Code, Goose, and every ACP CLI already
exist and keep improving. The scarce thing is the **orchestration layer**:

- one place where all agents, all machines, and all conversations live
- reachable from desktop, phone, and web with full fidelity (the Slack
  property: everything is live everywhere, nothing is trapped on one machine)
- trust and permissions handled once, centrally
- extensible, so the product can become whatever a given team's company needs

We deliberately do **not** build our own agent. `docs/00-architecture-overview.md`
already states the doctrine — *agents are subprocesses, not plugins* — and it
stays. Our moat is everything around the subprocess: transport, E2E encryption,
remote hosts, approvals, goals, history, and now rooms and extensions.

### What we take from Buzz (and what we don't)

Block's Buzz (built on Goose + Nostr) validates the same thesis: chat-shaped
collaboration where agents are **first-class members** — invited like humans,
holding persistent context, able to act unprompted, with one agent reviewing
another's work visibly in-thread. It is deliberately model- and agent-agnostic;
Claude Code, Codex, and Goose agents coexist in one channel.

We adopt: agents as named participants with identity and per-participant
configuration; the agent-reviews-agent pattern as a first-class flow; strict
agnosticism (any provider is a peer, none is privileged).

We skip (for now): Nostr/decentralized identity and public federation. Our
relay already gives every device and daemon a cryptographic identity with E2E
encryption; a small team doesn't need a global social protocol. If FalconDeck
ever federates between organizations, we revisit.

## 2. Naming

Two different things need names, and conflating them is the common mistake:

- **Connectors** — things you give to *agents*: MCP servers, skills, tools.
  ChatGPT-style "plugins". These need first-party UI support (§5) but are not
  code running inside FalconDeck.
- **Extensions** — things that extend *FalconDeck itself*: new panels, new
  conversation item types, new RPC methods, automations, integrations
  (a Linear panel, a deploy dashboard, a standup bot). Third-party code, run
  under our extension host (§6).

We use exactly these two words in UI, docs, and code. "Plugin" is banned from
the product vocabulary.

## 3. Architectural principles (protocol as product)

The 2026-08-07 audit's core finding: every capability boundary today is a
compiled `match` in Rust or a compiled `switch` in TS, the TS types are a
hand-maintained mirror of the Rust types, and client normalizers are whitelist
reconstructors that erase unknown fields. That is the architecture of an app,
not a platform. Six principles reverse it:

1. **The protocol is the product surface.** Third parties build against the
   daemon protocol, not our React code. It must be versioned (a `version` field
   on the snapshot and the relay handshake) and **machine-checked**: generate
   the TS types and JSON Schemas from the Rust types (`schemars` +
   `typeshare`/`ts-rs`), delete the hand-written mirror in
   `packages/client-core/src/types.ts`. No generated contract → no ecosystem.

2. **Tolerant readers everywhere.** Unknown event types are already ignored
   (good). Unknown conversation-item kinds must render a graceful fallback, not
   crash (desktop crash site fixed 2026-08-07). Normalizers must *pass through*
   unknown fields rather than rebuilding objects from a whitelist — today they
   silently drop anything new, which breaks old-client/new-daemon skew and
   makes extension data impossible.

3. **Open identifiers, not closed enums.** `AgentProvider` is already an open
   string id — the model to follow. Conversation-item `kind` and event `type`
   need the same treatment: a well-known set plus an extension escape hatch
   (`kind: "ext"` with `ext_type` + JSON payload, rendered by a generic card or
   an extension-registered renderer).

4. **Dynamic registration over compiled dispatch.** The relay already has the
   right shape — `rpc_methods` is a runtime `HashMap` keyed by method name, and
   it would happily route `ext.*` methods today. The daemon is the blocker:
   four hand-written parallel dispatchers (HTTP routes, RPC registration list,
   RPC dispatcher, queued-action dispatcher) that must be collapsed into one
   method table that both surfaces consume and extensions can add to. A test
   must assert the registration list and dispatcher agree — today that's a
   comment-enforced invariant.

5. **Namespaced state.** `daemon-state.json` is a closed struct rewritten
   whole-file; unknown keys are destroyed on the next write. Extensions get a
   per-extension KV store (`extensions/<id>/…`) via daemon API — never fields
   in core state. Also worth noting: FalconDeck is currently *not* the system
   of record for conversations (history is rehydrated from provider session
   files, and ACP threads lose history entirely on restart). Rooms (§4) force
   us to own an item log per thread; that is the moment to fix persistence.

6. **One transport client.** The relay/pairing/decrypt/RPC logic is hand-rolled
   three times (remote-web's `App.tsx`, mobile's `relay-store.ts`, desktop's
   `remote-host-client.ts`). Consolidate on `RemoteHostClient` in client-core
   as **the** way to speak to a daemon — the same library a third-party client
   or bot would use. "You can always access everything live" is only true if
   there's exactly one battle-tested implementation of "connect".

## 4. Multi-agent rooms

The product idea: a thread grows into a **room** — several agents and (later)
several humans, shared context, agents addressable and able to respond to each
other. Brainstorm with three models at once; have one agent implement while
another reviews; run a standup where each agent reports its goal progress.

What the audit says this collides with, and the design that resolves it:

- **Participants.** A thread gains `participants: Vec<ThreadParticipant>` —
  `{ id, kind: user|agent, provider, agent_params, display_name, color }`.
  Today's threads become rooms with one agent participant, so there is one code
  path, not two. The existing "threads are permanently bound to their provider"
  rule relaxes into "a participant is permanently bound to its provider" —
  same invariant, finer grain.
- **Authorship.** Every `ConversationItem` gains `author: Option<ParticipantId>`
  (serde-default so old items parse; absent = the thread's sole legacy agent).
  This is the single most invasive change — it touches core types, all three
  ingestion pipelines, and both renderer families — which is why it rides on
  the ProviderAdapter refactor (§7 phase 1) rather than preceding it.
- **Addressing.** A turn targets a participant: `turn.start` gains
  `participant_id`; the composer's provider picker becomes an @-mention.
  Default in a one-agent room: the only agent — today's UX is unchanged.
- **Per-participant state.** Thread `status`, `latest_turn_id`, `last_error`,
  and agent params move onto the participant; the thread-level values become
  aggregates for the sidebar. Two agents can then run concurrently in one room,
  which also requires runtimes keyed per (provider, thread) instead of the
  current one-`codex_session`-one-`claude_runtime`-per-workspace fields.
- **Agent-to-agent flows.** v1 is human-routed: you @-mention the reviewer
  agent and its turn input includes the room transcript (it already would —
  items are the shared context). v2 adds simple automation rules
  ("when A finishes a turn, ask B to review") — which is exactly the shape an
  extension can provide, so rules land as a first-party extension, proving the
  extension API.
- **Item identity.** Dedup maps are keyed by provider-native item ids; two
  agents can collide. Key becomes `(participant_id, native_id)`.

Non-goals for v1: multi-human presence in one room (the relay/E2E model
supports multiple devices of one user; multi-*user* needs identity work),
agents spontaneously initiating without a rule, and cross-thread agent memory.

## 5. Connectors: first-party MCP and skills UI

Agents already support MCP; FalconDeck currently passes **no** MCP config to
any provider (Claude spawn has no `--mcp-config`; ACP gets an explicit
`"mcpServers": []`). This is low-hanging fruit with outsized perceived value:

- A **Connectors** settings panel: add an MCP server (stdio command or URL +
  auth), scope it to a workspace or globally, toggle per thread/room.
- The daemon materializes the config per provider at spawn time (`--mcp-config`
  for Claude, `mcpServers` in the ACP `session/new`, Codex equivalent).
- Skills grow the same treatment: install/enable in UI, availability modeled as
  an open per-provider list (killing the `Codex|Claude|Both` lattice), and the
  hardcoded `.codex/skills`/`.claude/commands` scan generalized per provider.

This is also the answer for "agents need tools in a room": connectors are
room-scoped, so every participant sees the same tools.

## 6. Extensions: the host architecture

`docs/BB-ANALYSIS.md` already sketched the right shape; promoting it from
"deliberately not scheduled" to the platform roadmap:

- **Extension host sidecar** — a Node (or Deno) process the daemon spawns,
  speaking versioned JSON-RPC over stdio. The daemon stays pure Rust and never
  loads user code in-process.
- **Manifest** — each extension declares `contributes`: RPC methods
  (registered into the daemon's dynamic method table, §3.4, and forwarded to
  the relay so remote clients reach them), conversation item types (rendered
  via the `ext` item escape hatch, §3.3), sidebar/panel surfaces, slash
  commands, and automation triggers (thread events → extension callback).
  Plus `permissions`: which workspaces, which APIs, network or not.
- **Clients render extensions declaratively first** — schema-driven cards and
  panels — with sandboxed webviews as the later escape hatch. Declarative
  survives on mobile; webviews don't.
- **Trust model v1** — local, explicitly installed, listed in settings with
  their permissions. Signing/marketplace later. The `ee/` split stays
  orthogonal: extensions are the open ecosystem; `ee/` is our own commercial
  code.

## 7. Sequencing

Each phase is independently shippable and each unlocks the next:

- **Phase 0 — protocol hardening** (small, do first): type generation from
  Rust + schema publication; snapshot/handshake `version` field; tolerant
  normalizers (pass-through unknown fields); renderer fallbacks for unknown
  kinds; collapse the four daemon dispatchers into one method table with a
  registration-consistency test; consolidate transport on `RemoteHostClient`.
- **Phase 1 — provider agnosticism**: the `ProviderAdapter` trait refactor
  from `docs/PROVIDERS.md` §5 (collapse the ~55 hardcoded provider branches;
  per-provider maps replace named fields); ACP made first-class (capability
  refinement post-handshake, images, `session/load` rehydration, model
  listing); `providers.json` hot-reload plus a Providers settings panel.
- **Phase 2 — connectors**: MCP config UI + per-provider materialization;
  skills install/enable UI; open availability model.
- **Phase 3 — rooms**: participants, authorship, addressing, per-participant
  runtimes; FalconDeck-owned item log (system of record) lands here.
- **Phase 4 — extension host**: sidecar + manifest + dynamic RPC + declarative
  cards; automation rules ship as the first first-party extension.

Worktrees (`docs/WORKTREES.md`) are orthogonal daemon-side work and can
interleave anywhere; rooms make them *more* valuable (one participant per
variant reviewing another's diff).

## 8. Fixed during the audit (2026-08-07)

- `parse_agent_provider` on the remote-RPC ingress was a closed
  `codex|claude` match — remote clients selecting any ACP provider silently
  fell back to the workspace default. Now an open pass-through mirroring
  client-core's `normalizeProvider`.
- Desktop/remote-web `MessageCard` crashed on unknown item kinds (exhaustive
  switch, no default → React throws on `undefined`); now degrades to `null`.
- `normalizeThreadAgent` dropped `permission_mode`/`sandbox_mode` — fields the
  daemon sets — at the client boundary.

## 9. Open questions

1. **Rooms v1 scope** — is one-human-plus-N-agents enough for the first cut,
   or is multi-human (true team chat) required before it's interesting? Multi-
   human pulls identity/auth work forward substantially.
2. **System of record** — owning the conversation log (instead of rehydrating
   from provider session files) means storage, retention, and export decisions.
   SQLite per daemon is the obvious shape; confirm before Phase 3.
3. **Extension runtime** — Node maximizes ecosystem; Deno gives
   permissions-by-default sandboxing that matches our trust story. Leaning
   Deno; needs a decision before Phase 4.

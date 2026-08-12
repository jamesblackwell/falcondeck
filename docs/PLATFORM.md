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

UI, docs, and code use these two words. "Plugin" is fine as an informal
synonym for connectors (that's how ChatGPT-adjacent products use it) — we just
never use it for extensions, so the two concepts stay separable.

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

> **Status (2026-08-07): design only — deliberately not scheduled.** We are
> not building rooms now. This section is kept as the reference design so the
> foundational work (§4a) is shaped correctly. Revisit when the foundations
> are in and the product pull is real.

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

### 4a. Foundations we DO build now (rooms-enabling, feature-free)

Nearly everything rooms needs is already planned for other reasons; the rest
is two cheap schema decisions that are far more expensive retrofitted later:

1. **`author` on `ConversationItem`** — a `#[serde(default)]`
   `Option<String>` carrying the producing provider id, stamped by each
   ingestion pipeline (which already knows it). Additive on the wire, ignored
   by renderers today. Retrofitting authorship onto years of persisted
   anonymous items later is the single most painful migration rooms would
   force — take it now, while it's one field.
2. **Item dedup keyed `(source, native_id)`** instead of native id alone, so
   two agents emitting the same native id can never collide. One-line change
   at the dedup maps once ingestion converges.
3. **SQLite conversation log** (Phase 0, decision §9.2) — the room transcript
   must be FalconDeck-owned; also fixes ACP history loss today.
4. **One event sink** (Phase 1 ProviderAdapter work) — three ingestion
   pipelines converging on one sink means authorship stamping and log writes
   live in exactly one place.
5. **Runtimes in maps, not named fields** (Phase 1) — per-provider named
   fields (`codex_session`, `claude_runtime`) become keyed maps, which is
   also what concurrent per-participant runtimes need.
6. **Tolerant readers + versioning** (Phase 0) — lets `turn.start` grow a
   `participant_id` later without a breaking protocol change.

And the discipline while rooms stays unbuilt — don't deepen the hole: no new
code should assume thread ≡ provider beyond the existing `thread_provider()`
choke point, no new scalar per-thread agent state (prefer shapes that could
become per-participant), and no new provider-pair hardcoding anywhere.

## 5. Connectors: first-party MCP and skills UI

Agents already support MCP. The daemon-side pass-through **shipped 2026-08-07**
(pulled ahead of Phase 2 because it depends on nothing): a merged
`connectors.json` (global `~/.falcondeck/` + workspace `.falcondeck/`, see
`docs/CONNECTORS.md`) is materialized per provider at every spawn boundary —
`--mcp-config` for Claude, `mcpServers` in ACP `session/new`, `-c
mcp_servers.*` overrides for Codex — and re-read each turn, so edits apply
without a daemon restart. What remains for Phase 2 is the UI:

- A **Connectors** settings panel: add an MCP server (stdio command or URL +
  auth), scope it to a workspace or globally, toggle per thread/room — a
  visual editor over the same `connectors.json`.
- Skills grow the same treatment: install/enable in UI, availability modeled as
  an open per-provider list (killing the `Codex|Claude|Both` lattice), and the
  hardcoded `.codex/skills`/`.claude/commands` scan generalized per provider.

This is also the answer for "agents need tools in a room": connectors are
room-scoped, so every participant sees the same tools.

## 6. Extensions: the host architecture

`docs/EXTENSIONS.md` is the canonical architecture, authoring contract, and
phased implementation plan. `docs/BB-ANALYSIS.md` records the research that
informed it. The stable shape is:

- **Extension host sidecar** — a Deno process the daemon spawns,
  speaking versioned JSON-RPC over stdio. The daemon stays pure Rust and never
  loads user code in-process.
- **Manifest** — each extension declares `contributes`: actions and RPC methods
  (registered into the daemon's dynamic method table, §3.4, and forwarded to
  the relay so remote clients reach them), conversation item types (rendered
  via the `ext` item escape hatch, §3.3), sidebar/panel surfaces, slash
  commands, and automation triggers (thread events → extension callback).
  Plus `permissions`: which workspaces, which APIs, network or not.
- **Clients render extensions declaratively first** — schema-driven cards and
  panels — with sandboxed webviews as the later escape hatch. Declarative
  survives on mobile; webviews don't.
- **Private state and view state are separate** — implementation data remains
  namespaced and daemon-side; bounded non-secret projections flow through
  snapshots and sequenced events so every client stays coherent.
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
  registration-consistency test *(remote RPC half shipped 2026-08-07)*;
  consolidate transport on `RemoteHostClient`; begin the SQLite conversation
  log (system of record, decision §9.2, storing raw provider output alongside
  the projection so parser fixes replay instead of corrupting). Fold in the
  survey-backed schema moves from `docs/ADAPTERS.md` prior-art §1–5 while the
  wire is open: intent-normalized tool calls (`ActionType`), approval state
  on the tool call itself, RFC-6902 patch streaming, capabilities-as-data,
  and ACP-style forward-compat serde hygiene.
- **Phase 1 — provider agnosticism** *(mostly shipped 2026-08-07)*: ACP made
  first-class (capability refinement post-handshake, images, `session/load`
  rehydration, model listing) ✓; `providers.json` hot-reload + Agents settings
  panel ✓; skills availability opened to a per-provider list ✓; the
  `ProviderAdapter` refactor from `docs/PROVIDERS.md` §5 (collapse the
  hardcoded provider branches; per-provider maps replace named fields) — in
  progress.
- **Phase 2 — connectors** *(shipped 2026-08-07)*: Connectors settings UI
  over `connectors.json` with paste-JSON import and per-workspace scoping,
  plus a composer tools chip ✓. Still open: skills install/enable UI.
- **Phase 3 — extensions**: follow `docs/EXTENSIONS.md` from manifest and
  daemon foundations through the Deno host, declarative UI, and authoring CLI.
  Thread Tags is the first official extension and is enabled by default.
- **Unscheduled — rooms**: the feature itself (participants, addressing,
  per-participant status/UI) waits; its foundations ship inside Phases 0–1
  per §4a. Revisit once those land.

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

## 9. Decisions (locked 2026-08-07)

1. **Rooms: foundations now, feature later.** We build the rooms-enabling
   structure (§4a — item authorship, `(source, native_id)` dedup, SQLite log,
   single event sink, map-keyed runtimes, tolerant readers) inside Phases
   0–1, but do not implement rooms themselves. When rooms do land, v1 scope
   is one human + N agents — multi-human waits for real team demand.
2. **System of record: FalconDeck owns the conversation log — SQLite per
   daemon.** Rehydrating from provider session files already fails for ACP
   and cannot support authorship or rooms. Pulled forward into Phase 0/1
   rather than waiting for rooms.
3. **Extension runtime: Deno.** Permissions-by-default sandboxing matches the
   manifest/trust model, single binary to ship, still runs npm packages.
4. **MCP pass-through shipped immediately** (§5), out of phase order — small,
   dependency-free, and the most visible gap versus competitors.

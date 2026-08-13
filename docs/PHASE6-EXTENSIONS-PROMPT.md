# Agent prompt: Extensions Phase 6 — UI-contributing extensions

Copy everything below the line into a fresh agent session started in
`/Users/James/www/sites/falcondeck`.

---

You are taking over the FalconDeck extensions platform to deliver **Phase 6:
expand from demonstrated demand** — with the specific goal of making
**UI-contributing extensions** real. The product intent: FalconDeck wants to
ship opinionated features like "Zen mode" (one attention item at a time) and a
"Mission Control" thread grid as **official, disableable extensions** rather
than baking every idea into core. Your job is to build the platform capabilities
that make that possible, proven by a working official example.

## Read first, in this order

1. `docs/EXTENSIONS.md` — the canonical architecture and phased plan. Treat its
   10 non-negotiable rules (§3), required test layers (§15), compatibility
   policy (§16), and drift-prevention checklist (§17) as law. You must keep this
   document updated as you land changes — it self-describes as reconciled with
   code, and drift is a bug.
2. `docs/PLATFORM.md` §6–7 — product framing for extensions.
3. The implemented slice: `crates/falcondeck-daemon/src/app/extensions.rs`,
   `crates/falcondeck-daemon/src/app/extension_host.rs`,
   `apps/extension-host/main.ts`, `packages/extension-sdk/src/index.ts`,
   `schemas/extension-manifest.schema.json`, `extensions/official/thread-tags/`,
   `packages/client-core/src/extension-views.ts`, `extensions/AGENTS.md`.
4. `docs/ACTIVITY-VIEW.md` — the first-party Activity view plan. It is being
   built in core in parallel; it documents the App.tsx main-pane takeover seam
   your panels work must generalize. Coordinate, don't collide: do not modify
   the Activity view itself.

## Honest current state (verified 2026-08-13, don't rediscover it the hard way)

The platform is solid **below** the UI line and a stub **above** it:

- Exactly three contribution kinds exist in the schema and Rust types
  (`threadMenuActions`, `threadDecorations`, `sidebarFilters`). They are
  transported end-to-end but **no client has a generic renderer for any of
  them** — the one shipped extension (Thread Colours) is hand-wired by its
  hardcoded id (`falcondeck.thread-tags`) into desktop, remote-web, and mobile
  via `packages/client-core/src/extension-views.ts`. There is even a
  `falcondeck.thread-tags` literal in `extensions.rs`.
- Phase 3 (versioned declarative component vocabulary + shared renderers) was
  **never built**, despite Phases 4–5 items partially landing. It is your real
  prerequisite.
- The Deno host protocol supports exactly one method: `action.invoke`.
  No activation RPC, no event delivery, no query RPC. Storage is passed
  whole in/out per call. 10s action timeout.
- SDK facets `events`, `threads`, and `commands` are documented as Planned and
  do not exist.
- The v0.1 manifest validator **requires `permissions: []`** (`maxItems: 0`) —
  the permission system has no enforcement, so nothing gated can ship yet.
- `packages/extension-testing` (the fake host) is named in the plan but does
  not exist on disk. Per §15, every SDK feature you add without fake-host
  support is incomplete — you will have to create this package early.
- Only `npm run extension:validate` exists of the planned CLI.

## Mission, sliced

Work in reviewable slices, each meeting its §15 test layers and each proven by
an official or example extension with no private imports. Propose a concrete
plan (files, schema changes, test matrix) **before writing code** for each
slice, and get it reviewed. Suggested sequence:

1. **Phase 3 core, scoped to what panels need**: the versioned declarative
   component/action-binding schema and a shared web renderer in
   `packages/chat-ui`, with the generic unsupported-contribution fallback.
   Include a generic renderer for at least one *existing* contribution kind
   (`sidebarFilters` is the smallest) to retire one piece of the hardcoded
   Thread Colours wiring and prove the renderer against real data.
2. **`panels` contribution kind**: a named full-screen main-area surface.
   Daemon: schema + `ExtensionContributions` in `crates/falcondeck-core`,
   limits, view-state plumbing (it already generalizes). Desktop: refactor the
   `App.tsx` main-pane ternary (`isScheduledOpen ? … : isSettingsOpen ? …`,
   ~line 3995) into a **view registry keyed by id**, register the existing
   first-party takeovers in it, then render extension panels through the
   declarative renderer. Remote-web parity; mobile gets the required visible
   fallback ("this extension provides a panel not yet supported here"), which
   the doc counts as a complete fallback, not an omission.
3. **`events` facet**: daemon → extension push over a new host RPC
   (e.g. `event.dispatch`), starting with thread lifecycle/attention events
   (`ThreadUpdated`, `TurnEnd`, interactive-request opened/resolved).
   Delivery must respect host lifecycle (lazy start, crash, disable),
   be bounded (queue limits, drop policy), and be observable in tests.
4. **Permissions v1 + `threads` read facet**: real grant storage and
   enforcement in the daemon, manifest validator lifted from `maxItems: 0` to
   declared-and-enforced, `threads:read` scoping (summaries only, no transcript
   content in v1), payload reduction to granted fields, and settings UI for
   grants. This is the slice where "denied by default" gets teeth — nothing in
   slices 1–3 may quietly widen access ahead of it (events carrying thread data
   count as reads; gate accordingly or restrict early event payloads to ids).
5. **Proof extension**: an official example panel that subscribes to attention
   events and renders an opinionated attention list (a deliberate mini-Zen).
   It must be buildable by an outside agent following `extensions/AGENTS.md`
   and repository docs alone.

Slices 3 and 4 may swap or interleave if enforcement-first turns out cleaner —
justify in your plan. Do not start marketplace, signing, webviews, whole-region
replacement, or cross-extension calls (§14 Phase 6 explicitly defers these).

## Constraints and house rules

- Daemon stays authoritative; no extension code ever runs in clients (rule 4).
- Every new capability needs: a permission, enforced size/count limits,
  fake-host support, client fallback on older clients, and a consuming example.
- Contribution and view ids are persisted API. Wire types live in
  `crates/falcondeck-core/src/lib.rs` with hand-maintained TS mirrors in
  `packages/client-core/src/types.ts` + defensive normalization in
  `normalization.ts` — keep all three in lockstep, with tests.
- Update `docs/EXTENSIONS.md` in the same PR as every behavior change; answer
  §17's checklist in your plan for each new capability.
- Rust: `rustup` here ignores `rust-toolchain.toml` — build/test with
  `rustup run stable-aarch64-apple-darwin cargo <cmd>`.
- JS: after any dependency change run `npm install` so the lockfile stays in
  sync (EAS/CI use `npm ci`).
- Validation: `npm run extension:validate`; run workspace vitest suites and the
  daemon's cargo tests for every slice; `npm run` scripts at the repo root list
  the rest.
- Other agents work in this tree concurrently. Keep your changes scoped to the
  extensions surface, stage only hunks you own, and if you must touch
  `apps/desktop/src/App.tsx` (the view-registry refactor), do it as its own
  small, early, well-tested commit so the parallel Activity-view work can
  rebase onto it cleanly.

Deliverable per slice: plan → implementation → tests across the §15 layers →
docs reconciliation → short summary of what an extension author can now do that
they couldn't before.

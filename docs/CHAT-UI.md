# Chat UI baseline: copy Zed, then tweak

Decision (2026-08-07): FalconDeck's transcript and composer take **Zed's agent
panel as the baseline**, rather than continuing to tune our own. Zed is a Rust
app whose agent panel drives the same ACP protocol we already speak, its
source is readable (`zed-industries/zed`, `crates/agent_ui/`,
`crates/acp_thread/`), and our orchestrator survey found it is where the field
converged on transcript density. Implement its behaviour first, tweak second.

Prior research: `docs/ADAPTERS.md` "Prior art" §7 has the mechanics with file
references. This doc is the build spec.

## 1. Composer: the toggle row

Zed puts a single row of quiet dropdown toggles under the input, e.g.
`Agent (full access) ⌄  Default ⌄  GPT-5.6-Sol ⌄  Low ⌄  Fast mode (•)`.

What to copy:

- **One row, text-first, no boxes.** Label + chevron, muted until hover. Ours
  are heavier chips; drop the borders and let them read as text.
- **Order is capability → mode → model → effort → switches.** Permission scope
  first (it is the one with consequences), then behaviour mode, then model,
  then reasoning effort, then boolean switches last.
- **A real toggle for booleans** (Zed's "Fast mode"), not a dropdown with two
  options. Built (2026-08-08) as the composer's `FastModeToggle`: models
  advertise `service_tiers` (Codex fast mode is tier id `priority`), the
  toggle mounts when any model of the provider has one, greys when the
  selected model doesn't, and turns send the tier — or the explicit
  `default` reset — on every request.
- **Disable rather than hide** when a provider lacks a capability — Zed keeps
  the affordance and greys it (`thread_view.rs:5640`), so the composer does not
  reflow between providers. This matters more for us than for Zed: our provider
  set is open, so pickers appear and vanish per agent today.
- Everything in the row is already capability-gated data on our side
  (`AgentCapabilitySummary` + the workspace agent entry), so this is
  presentation work, not plumbing.

## 2. Transcript: what collapses and what does not

Zed's rules, which we adopt wholesale:

- **Everything starts collapsed.** `expanded_tool_calls` starts empty, and
  expansion is keyed **by tool-call id, not list index**, so it survives
  re-render and reordering. (Ours keys by id already — keep it.)
- **Three visual tiers**, not one:
  1. *Bordered card* — only for edits, terminal/execute, and anything awaiting
     confirmation.
  2. *Quiet one-line row* with a hover-revealed chevron — reads, searches,
     fetches, everything else.
  3. *Forced open, collapse disabled* — awaiting confirmation. You cannot hide
     what you are being asked to approve.
- **Raw input is a second, nested disclosure**, suppressed where it would
  duplicate the rendered content.
- **Thinking is a four-value setting**: `Auto | Preview | AlwaysExpanded |
  AlwaysCollapsed`. `Auto` expands the streaming thought and auto-collapses it
  when it ends *unless the user toggled it*; `Preview` height-caps with a fade
  that a click promotes to full. Rendered as a left rule, not a box.
  **We currently drop reasoning entirely — there is no way to reveal it.** This
  is the biggest single gap.
- **Plans live above the composer**, collapsed to `Current: <step>` with an
  "{n} left" badge, then pin into the transcript when complete.

## 3. Code and diffs in the transcript

- Syntax-highlight code; render diffs as diffs with gutters (in flight).
- Cap long output with a preview + "show more" (shipped).
- **Add a global "show code in transcript" toggle.** James's call: Zed shows
  more code inline than we want by default. Default it to summaries-only
  (file + line count + a click to expand), with the toggle restoring inline
  bodies. This is a preference, not a per-tool decision.
- Rich output belongs in panels, not the transcript — Zed routes to real
  editors/terminals; our equivalent is the diff sidebar.

## 4. What we deliberately do not copy

- Zed's multibuffer editing surface — we are not an editor.
- Its per-thread token/cost meter, for now.
- GPUI-specific interaction affordances that assume a desktop-only client;
  every rule above must also work in the mobile renderer.

## 5. Order of work

1. Reasoning reveal (the `Auto`/`Preview` thinking model) — closes a hole
   where information is currently unreachable.
2. Three-tier tool cards + forced-open approvals.
3. Composer toggle row restyle.
4. "Show code inline" preference.
5. Plan-above-composer treatment.

# FalconDeck UI Handoff

This document is for the next agent working on FalconDeck’s UI/UX layer.

The backend, relay, encryption, pairing, and remote sync are now substantially working. The biggest remaining problem is the product experience: layout, hierarchy, rendering quality, and clarity are not good enough yet.

## Design Brief

The next UI pass should be creatively ambitious, but structurally disciplined.

That means:
- do not preserve the current visual design out of politeness
- do not treat the existing layout as precious
- do not do a total-from-scratch product rethink that breaks working flows or contracts

The right mindset is:
- bold aesthetic re-interpretation
- conservative product architecture

In other words:
- redesign the presentation aggressively
- keep the mental model, technical model, and core user flows intact unless there is a strong product reason not to

## Creative Freedom vs. Boundaries

The next agent should have broad freedom in:
- typography
- spacing
- shell composition
- card/component treatments
- motion
- density
- atmosphere
- visual hierarchy
- how “desktop control plane” feels as a product

But should not casually change:
- daemon contracts
- relay contracts
- conversation item model
- thread/project information architecture
- approval semantics
- remote pairing flow
- the fact that desktop and remote web are two clients of the same underlying system

This should not become “invent a different app.”
It should become “turn the existing app into something coherent, memorable, and actually good.”

## Current Product State

What works:
- Desktop app can connect a local project/workspace.
- Desktop app can start Codex threads and send prompts.
- Public relay is deployed and working.
- QR pairing works.
- Hosted remote web app can claim a session and connect through the encrypted relay.
- Remote web app can receive live workspace/thread state and send prompts.
- Remote approvals are intended only for Codex permission prompts, not for every user action.

What is still poor:
- Desktop UI layout is visually weak and often confusing.
- Message rendering is functional but not polished enough.
- Information hierarchy is unclear.
- Remote pairing/status area is oversized and awkward.
- The right rail is not especially useful yet.
- Composer layout and controls feel raw.
- The app still looks like an internal prototype instead of a product.

## What We Want

The intended product is:
- a desktop-first agent control plane
- a clean three-column shell
- grouped by project in the sidebar
- threads within each project
- a very strong conversation experience in the center
- a useful contextual side panel for approvals, plan, diff, and remote status
- a remote client that feels like the same product, not a separate tool

## Desired Design Standard

The current UI is not merely rough, it is underdesigned.
The next pass should aim for something that feels authored and unmistakable.

Specifically:
- commit to a strong aesthetic point of view
- avoid timid midpoint design
- avoid generic startup dashboard energy
- avoid default-looking component assembly
- make the interface feel like a premium instrument, not a CRUD admin panel

The best outcome is not “prettier.”
The best outcome is “clear, distinctive, and confident.”

## How To Apply Creative Direction Safely

Before changing code, the next agent should explicitly decide:
- purpose: what the screen is helping the user do right now
- tone: what aesthetic extreme the product should lean toward
- differentiation: what one feeling or visual idea should make FalconDeck memorable
- constraints: what existing flows and technical contracts must remain stable

Good examples of acceptable directions:
- refined, cinematic dark control room
- editorial, high-contrast machine console
- industrial precision instrument
- minimal but luxurious operator surface
- brutalist command center

The exact direction is open.
What matters is commitment and consistency.

## Important Constraint On Redesign Scope

The next agent should not interpret “creative freedom” as permission to restart the frontend architecture.

Prefer:
- recompose existing surfaces
- improve shared components
- introduce stronger design tokens
- improve content rendering
- reorganize layout intelligently

Avoid unless necessary:
- replacing the entire app structure
- inventing a second parallel state model
- rewriting working data plumbing just to support a visual idea
- introducing large new backend requirements for cosmetic reasons

If a major product change is proposed, it should be because it clearly improves usability, not because the current UI is ugly.

The desired interaction model:
- Project/workspace first
- Thread second
- Conversation is the primary surface
- Remote status should be present but not dominate the layout
- Approvals should be obvious when they exist and invisible when they do not
- Model/effort/mode controls should feel like first-class prompt controls, similar to Codex

## Key Files

### Desktop app
- [apps/desktop/src/App.tsx](/Users/James/www/sites/falcondeck/apps/desktop/src/App.tsx)
  - Main desktop shell
  - Loads snapshot, thread detail, remote status
  - Connects to daemon event stream
  - Handles add project, start pairing, send turn, approvals
- [apps/desktop/src/api.ts](/Users/James/www/sites/falcondeck/apps/desktop/src/api.ts)
  - Desktop-side Tauri/bootstrap helpers
- [apps/desktop/src/store.ts](/Users/James/www/sites/falcondeck/apps/desktop/src/store.ts)
  - Older event/timeline reducer helpers used by tests
  - Useful for understanding prior event-driven rendering assumptions
- [apps/desktop/src/App.css](/Users/James/www/sites/falcondeck/apps/desktop/src/App.css)
  - Legacy desktop styling layer
  - Some of this is now superseded by shared UI packages

### Remote web app
- [apps/remote-web/src/App.tsx](/Users/James/www/sites/falcondeck/apps/remote-web/src/App.tsx)
  - Main hosted remote client
  - Handles pairing claim, websocket session, encrypted replay, encrypted RPC calls
  - Shares the same general shell structure as desktop, but simplified

### Shared client logic
- [packages/client-core/src/types.ts](/Users/James/www/sites/falcondeck/packages/client-core/src/types.ts)
  - Shared TS contract for snapshot, thread detail, relay types, conversation items
- [packages/client-core/src/conversation.ts](/Users/James/www/sites/falcondeck/packages/client-core/src/conversation.ts)
  - Conversation item sorting and event application helpers
- [packages/client-core/src/grouping.ts](/Users/James/www/sites/falcondeck/packages/client-core/src/grouping.ts)
  - Project/workspace grouping logic used in sidebar views
- [packages/client-core/src/daemon-client.ts](/Users/James/www/sites/falcondeck/packages/client-core/src/daemon-client.ts)
  - Shared daemon API client
- [packages/client-core/src/crypto.ts](/Users/James/www/sites/falcondeck/packages/client-core/src/crypto.ts)
  - Shared browser-side relay crypto helpers
  - Relevant for remote UX states like “awaiting encrypted session”

### Shared UI/chat components
- [packages/chat-ui/src/components/conversation.tsx](/Users/James/www/sites/falcondeck/packages/chat-ui/src/components/conversation.tsx)
  - Main conversation container
- [packages/chat-ui/src/components/message.tsx](/Users/James/www/sites/falcondeck/packages/chat-ui/src/components/message.tsx)
  - Renders user/assistant/tool/plan/diff/approval/reasoning items
- [packages/chat-ui/src/components/prompt-input.tsx](/Users/James/www/sites/falcondeck/packages/chat-ui/src/components/prompt-input.tsx)
  - Composer surface with attachments, model selector, effort selector, mode selector
- [packages/chat-ui/src/components/model-selector.tsx](/Users/James/www/sites/falcondeck/packages/chat-ui/src/components/model-selector.tsx)
  - Model/effort/mode controls
- [packages/chat-ui/src/components/code-block.tsx](/Users/James/www/sites/falcondeck/packages/chat-ui/src/components/code-block.tsx)
  - Code block rendering
- [packages/ui/src/](/Users/James/www/sites/falcondeck/packages/ui/src)
  - Shared UI primitives used by both desktop and remote

### Backend files that affect UI behavior
- [crates/falcondeck-daemon/src/app.rs](/Users/James/www/sites/falcondeck/crates/falcondeck-daemon/src/app.rs)
  - Most important daemon-side event normalization logic
  - Converts Codex notifications into FalconDeck conversation items and unified events
  - If the UI is showing weird raw internal items, the cause is often here
- [crates/falcondeck-daemon/src/codex.rs](/Users/James/www/sites/falcondeck/crates/falcondeck-daemon/src/codex.rs)
  - Codex bootstrap parsing, account status parsing, model parsing, thread list parsing
- [crates/falcondeck-core/src/lib.rs](/Users/James/www/sites/falcondeck/crates/falcondeck-core/src/lib.rs)
  - Shared Rust contract for snapshots, conversation items, threads, relay messages

## Important Technical Intent

The UI should not invent its own data model.

The intended flow is:
- Codex native events are normalized in the Rust daemon
- Desktop and remote clients consume the normalized model
- `ConversationItem` is the canonical render surface for chat
- `ThreadDetail` is the canonical “selected thread” payload
- `DaemonSnapshot` is the canonical overview payload

That means the next UI agent should prefer:
- improving rendering of `ConversationItem`
- improving shell structure around `DaemonSnapshot` and `ThreadDetail`
- avoiding ad hoc transforms in the React layer unless absolutely necessary

## Current UX Problems To Fix

### 1. Desktop layout
- The current proportions are poor.
- The remote pairing area is too tall and visually heavy.
- The composer area consumes too much awkward space.
- The center column lacks good vertical rhythm.
- Borders and sections feel noisy rather than helpful.

### 2. Sidebar
- Grouping by project exists, but it does not feel confident.
- Project cards and thread rows need clearer contrast and spacing.
- “Add Project” input/button treatment is clumsy.
- Status indicators are not well integrated.

### 3. Conversation surface
- This is the most important area and currently feels underdesigned.
- Message cards need stronger differentiation between:
  - user messages
  - assistant messages
  - reasoning blocks
  - command/tool execution
  - plans
  - diffs
  - approval requests
- Streaming / active turn states should feel alive and clear.

### 4. Composer
- The composer is technically capable but visually poor.
- File/image attachment affordance is ugly.
- Control placement feels cramped and arbitrary.
- Model/effort/mode controls should feel intentional and Codex-like.

### 5. Right rail
- It exists but does not earn its space.
- It should become a genuinely useful context column, not a dump of boxes.
- Remote status can likely collapse into a smaller smarter panel.
- Approvals should be high-signal when present, quiet when absent.

### 6. Remote web UX
- Functional, but not polished.
- The remote client should feel like a compact control companion, not a second-rate clone.
- Connection state, pairing, and encrypted session state should be understandable at a glance.

## Known Product Truths

- Remote approvals refer to Codex permission prompts only.
- We do not want every action to require approval.
- The relay is now end-to-end encrypted for session content.
- The relay stores encrypted update envelopes and bootstrap material, not plaintext session content.
- Codex auth state was previously misreported in the UI and has been fixed in daemon parsing.

## Known Functional Fixes Already Landed

These are already fixed and should not be reintroduced:
- false `needs auth` state when `account/read` includes a real signed-in account
- leaking internal Codex `userMessage`, `agentMessage`, and `reasoning` item kinds as fake tool cards
- relay crash on legacy plaintext state during encrypted upgrade
- pairing/bootstrap acceptance without verifying the bootstrap was addressed to the current client key

## Suggested Design Direction

The next agent should focus on product quality, not protocol work.

Recommended priorities:
1. Reshape the desktop shell into a cleaner, calmer three-column layout
2. Make the conversation area excellent
3. Simplify and improve the composer
4. Reduce right-rail clutter
5. Bring the remote client to the same information architecture, just denser and more compact

Good references already discussed for this:
- CodexMonitor for high-level shell/orchestration ideas
- AI Elements for conversation/composer patterns
- shared shadcn-style primitives already in `packages/ui`

## What Not To Do

- Do not rewrite the relay or daemon contracts just to make the UI easier.
- Do not reintroduce bespoke raw event rendering as the main experience.
- Do not treat approvals as the main interaction model.
- Do not assume the auth badge is trustworthy without checking daemon parsing first.
- Do not optimize for pretty screenshots over readable, usable session flow.

## Best Immediate Handoff Task

If another design-focused agent takes over, the best first task is:

- redesign desktop shell layout
- improve conversation rendering hierarchy
- refine composer controls and prompt area
- keep the current data contracts intact
- verify both desktop and remote still work with live snapshot/thread detail data

## Concrete Instruction For The Next UI Agent

Please read this as:

- You are encouraged to be bold.
- You are not required to preserve the current appearance.
- You should improve the product dramatically.
- You should not casually discard the existing working architecture.

Treat the current implementation as a functioning but badly designed shell around real backend capabilities.
Your job is to turn that shell into a product-grade interface, not to rebuild FalconDeck from zero.

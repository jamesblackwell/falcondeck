# UI Design Decisions

Last updated: 2026-03-15

## Reference Implementation

**CodexMonitor** (github.com/Dimillian/CodexMonitor) is the primary UI reference for FalconDeck v1. Same stack (Tauri 2 + React 19 + TypeScript + Vite), open source, well-structured. We borrow the layout, design system, and component patterns — adapting where needed for multi-agent support.

CodexMonitor is not perfect: it's Codex-only and could be cleaner/more minimal. But it's close enough to start from and iterate.

## v1 Approach

Start with **Codex app-server integration** and the **remote/relay** layer. Get a single Codex session working end-to-end (desktop → relay → mobile), then layer in Claude Code support.

## Layout

Borrow CodexMonitor's three-panel layout and orchestration split:

```
┌──────────┬─────────────────────────┬────────────┐
│          │  Topbar (workspace,     │            │
│ Sidebar  │  branch, status, model) │  Right     │
│ (280px)  ├─────────────────────────┤  Panel     │
│          │                         │  (230px)   │
│ Sessions │  Messages / Diff split  │            │
│ list     │  (resizable)            │  Plan /    │
│          │                         │  Files     │
│          ├─────────────────────────┤            │
│          │  Composer               │            │
└──────────┴─────────────────────────┴────────────┘
```

- Use a reducer/orchestration approach similar to CodexMonitor: bootstrap, event handling, thread normalization, and view state should be separated from presentational components.
- Group threads by project/workspace in the sidebar. The top-level navigation unit is the project, not a flat thread list.
- All panels should be able to collapse; resizable splits are desirable and can land incrementally as the shell stabilizes.
- Messages ↔ diff split remains a core interaction pattern.

### Responsive

- **Desktop**: full three-panel grid
- **Tablet**: resizable sidebar + tabbed main area (projects / agent / git / log)
- **Phone**: bottom tab bar, one view at a time, safe area inset support

This responsive system is already built in CodexMonitor and targets the same Tauri iOS path we'll use.

## Design System

Use Tailwind CSS v4 with shared tokens and shadcn-style primitives. We are no longer pursuing a bespoke CSS-only component system.

### Theme

- **Dark-first** (default), with light, dim, and system-follow modes
- Shared CSS variables live in the shared UI package and should drive the semantic look across desktop, remote web, and site
- Minimal, clean aesthetic — simplify from CodexMonitor where possible

### Color approach

Borrow CodexMonitor's token structure, but expose it through semantic component wrappers:
- Text: primary / strong / muted / subtle / faint / dim
- Surfaces: sidebar / topbar / messages / card / control
- Borders: subtle / strong / accent
- Status: success (teal) / warning (orange) / error (red)

### Typography

- UI: system font stack (system-ui, -apple-system, etc.)
- Code: monospace stack (ui-monospace, Cascadia Mono, Menlo, etc.)
- Code at 11px — optimised for dense output

### Motion

Fast, subtle animations. CodexMonitor's pacing is still a good reference:
- Fast: 120ms, Normal: 160ms, Slow: 220ms
- Easing: cubic-bezier(0.16, 1, 0.3, 1)

### Icons

lucide-react — lightweight, consistent, widely used.

## Components

Start from shared packages and proven off-the-shelf patterns instead of rebuilding primitives:

- `packages/ui`
  - shared primitives in the style of shadcn (`Button`, `Card`, `Input`, `Textarea`, `Badge`, `Select`, `ScrollArea`, etc.)
- `packages/chat-ui`
  - AI Elements-inspired components for `PromptInput`, `Conversation`, `Message`, `CodeBlock`, and `ModelSelector`
- app-specific composition
  - desktop and remote shells compose these shared components rather than forking their own copies

This keeps the component surface familiar, testable, and future-friendly for the eventual React Native app, where only the headless client logic will be shared.

## Agent Status Display

Both agent protocols provide live status information:

- **Codex app-server**: turn/item notifications — thinking, tool use, streaming text, approval requests, idle
- **Claude Code CLI**: stream-json events — tool-call-start, tool-call-end, text streaming, turn boundaries

The unified event format normalises these into consistent status states. The UI shows:
- **Session status**: running / thinking / waiting for approval / idle / stopped
- **Live activity**: what tool is being used, what file is being edited
- **Last message preview**: in the session list sidebar

No special treatment needed per agent type — the unified event format handles this.

## Multi-Agent Adaptations

Where FalconDeck diverges from CodexMonitor:

| Area | CodexMonitor | FalconDeck |
|---|---|---|
| Session list | Codex threads only | Sessions tagged by agent type (icon + label) |
| Agent lifecycle | One codex app-server per workspace | Multiple agent processes per workspace over time, but v1 remains Codex-first |
| Message rendering | Codex message protocol | Unified event format |
| Composer capabilities | Codex skills/prompts hardcoded | Query agent capabilities dynamically |
| Approval prompts | Codex approval format | Unified permission RPC |
| Settings | Codex binary + config.toml | Per-agent binary paths and config |
| Code review | "Ask PR" via Codex | Agent-agnostic review |

## What We Skip for v1

- Worktree management UI (we don't force worktrees)
- Claude-specific UX until the Codex path is solid
- Over-customized theming beyond dark/light/dim/system

## Keyboard & Interaction

- Keyboard-first, platform-aware (Cmd on macOS, Ctrl elsewhere)
- Configurable shortcuts via settings
- Command palette (Cmd+K) — add when we have enough actions to justify it
- Context menus on sessions, messages, files

## Hosting Split

- `falcondeck.com` serves the public site and `/pair` landing
- `app.falcondeck.com` serves the same pairing landing (legacy QR host)
- `connect.falcondeck.com` serves the relay

QR codes encode `falcondeck://pair` so the iPhone camera opens the mobile app.
Copied pairing links target `https://falcondeck.com/pair`, which opens the app
or asks the user to install it. Do not point pairing at the relay origin.

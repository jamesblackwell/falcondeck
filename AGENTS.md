# FalconDeck Agent Guide

## Project Shape

FalconDeck is a monorepo. Keep related apps and shared protocol/runtime code together.

Current structure:
- `apps/desktop` — Tauri desktop shell and React UI
- `apps/site` — public-facing website placeholder
- `apps/remote-web` — remote browser client
- `crates/falcondeck-core` — shared types and protocol models
- `crates/falcondeck-daemon` — local daemon and Codex integration
- `crates/falcondeck-relay` — public relay server
- `ops/ansible` — deployment automation and server templates
- `docs/` — architecture and protocol notes

## Architecture Rules

- The daemon is the product. The desktop app is a shell around it.
- Use `codex app-server` for Codex. Do not use the MCP server.
- Claude support is phase 2 and should use the CLI subprocess path, not the Agent SDK.
- Sessions stay in native agent storage. FalconDeck should not create its own conversation database.
- Same-folder workflows are the default. Do not force worktrees.
- Remote access should follow the Happy-style relay model: E2E encrypted, stateful relay, reconnect by sequence number.

## Current Priorities

1. Keep the existing desktop + daemon flow working.
2. Build the relay server in `crates/falcondeck-relay`.
3. Build the remote web client in `apps/remote-web`.
4. Build the public site in `apps/site`.
5. Add Claude Code after the Codex + relay path is solid.

## Implementation Notes

- Read `docs/` before making protocol or architectural changes.
- Prefer shared protocol changes in `crates/falcondeck-core` first, then fan out to daemon/UI/relay.
- The frontend stack now uses shared packages plus Tailwind v4 and shadcn-style primitives:
  - `packages/client-core` for shared TS models, grouping, conversation helpers, and API clients
  - `packages/ui` for shared UI primitives and theme tokens
  - `packages/chat-ui` for AI chat/conversation/composer surfaces
- Use semantic wrappers and shared tokens rather than ad hoc utility soup.
- Keep `AGENTS.md` concise and operational. Put deep design rationale in `docs/`.
- Keep real deployment inventory and secrets out of git. Commit examples/templates only.
- Do not add Electron, custom crypto, or forced account/login flows for v1.

## UI and Hosting Defaults

- Use grouped project/workspace navigation in both desktop and remote clients.
- Prefer AI Elements-style chat surfaces for conversation, prompt input, model selection, and code blocks.
- `connect.falcondeck.com` is the public relay.
- `app.falcondeck.com` is the hosted remote client.
- `falcondeck.com` is the public marketing/site app.

## Reference Implementations

- CodexMonitor: UI/layout and Codex app-server patterns
- Happy: relay, encryption, reconnect, permissions, unified event model

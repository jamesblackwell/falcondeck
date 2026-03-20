# FalconDeck Agent Guide

## Overview

FalconDeck is a monorepo for a local daemon-first agent control plane:

- `apps/desktop` - Tauri shell around the daemon
- `apps/mobile` - paired mobile client
- `apps/remote-web` - paired browser client
- `apps/site` - public marketing site
- `packages/client-core` - shared TS protocol, types, helpers
- `packages/ui`, `packages/chat-ui` - shared UI primitives
- `crates/falcondeck-core` - shared Rust protocol and types
- `crates/falcondeck-daemon` - local daemon, agent integration, unified event stream, relay bridge
- `crates/falcondeck-relay` - public relay with encrypted replay storage and trusted-device pairing
- `ops/ansible` - deploy and server config

## Core Rules

- The daemon is the product; desktop is just its shell.
- Use `codex app-server` for Codex, not the MCP server path.
- Keep Claude on the CLI subprocess path, not the Agent SDK.
- Sessions and conversation history belong to the underlying agent. Do not add a FalconDeck conversation DB.
- Default to same-folder workflows. Do not force worktrees.
- Start shared protocol changes in `crates/falcondeck-core` and `packages/client-core`, then fan out.

## Gotchas

- The relay is stateful but not the conversation source of truth. The daemon and native agent storage are. Relay replay only smooths remote reconnects.
- Pairings are short-lived onboarding state. Trusted devices are the long-lived relationship.
- Relay replay may be pruned. When history is truncated, clients must recover from a fresh daemon snapshot, not assume full replay remains.
- Relay sequence numbers must stay monotonic after pruning. Do not derive `next_seq` from the last retained update.
- The daemon is currently localhost-first. `falcondeck-daemon` binds to `127.0.0.1` by default. Do not document direct-hosted web product behavior unless it actually exists.
- Remote and mobile access depend on daemon RPC registration. Methods like `snapshot.current`, `thread.detail`, `turn.start`, and approval handlers are part of that contract; changing names or flow breaks clients.
- Remote clients are clients of the daemon, not separate durable stores. Before adding remote-only persistence, check whether it belongs in the daemon or native agent storage instead.
- Production relay storage uses Postgres. File-backed relay state still exists for local, test, and simple setups.
- Keep secrets and real inventory out of git. `ops/ansible/inventory/example` and example vars are safe; real hosts, creds, and production inventory are not.

## Working Guidelines

- Read `docs/` before changing protocol or architecture.
- Read `DESIGN.md` before changing shared UI, branding, or iconography.
- Keep `AGENTS.md` short and operational; put rationale in `docs/`.
- Prefer semantic shared UI wrappers over ad hoc utility-heavy markup.
- Preserve hosting defaults:
- `connect.falcondeck.com` - relay
- `app.falcondeck.com` - hosted remote web app
- `falcondeck.com` - public site
- You may use Ansible and SSH on the production relay/app host for deployment, debugging, and verification when needed.

## Priorities

1. Keep the desktop and daemon flow solid.
2. Keep relay protocol and retention/reconnect behavior correct.
3. Keep remote web and mobile aligned with daemon/relay contracts.
4. Keep the public site simple and separate from product runtime concerns.
5. Expand Claude support without regressing the Codex path.

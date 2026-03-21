# FalconDeck

FalconDeck is a control panel for AI coding agents that lets you work with Codex and Claude in one place across desktop, web, and mobile. It is built for staying in flow at your desk and continuing on the go through a secure end-to-end encrypted relay that is also self-hostable.

Under the hood, FalconDeck is a local daemon-first system that keeps the daemon and native agent storage as the source of truth. That means less glue code, fewer competing state stores, and a cleaner path to remote access, reconnects, approvals, and shared project context.

## Why FalconDeck

FalconDeck keeps your main agent workflow local, then layers in remote access without turning a cloud service into the source of truth. The desktop app is a shell around the daemon, while mobile and web connect back through the relay for pairing, replay, reconnects, and remote actions.

The relay transports and stores encrypted payloads, not plaintext conversation content. If you want to run your own infrastructure, the relay is self-hostable and the repo already includes deployment automation for that path.

## Core Benefits

- Local-first architecture with the daemon as the product, not just a thin UI wrapper
- One control plane for multiple agent providers
- Desktop, mobile, and web clients backed by the same daemon contract
- Secure remote access through an end-to-end encrypted relay
- Self-hostable relay and hosted web stack
- Remote access without turning the relay into the source of truth
- Better resilience across reconnects, restarts, and device handoff
- Same-folder workflows by default, without forcing worktrees

## Features

- Embedded local daemon for desktop with a localhost-first HTTP API
- Support for Codex and Claude runtimes
- Persistent workspace and thread restoration
- Unified event stream for sessions, turns, approvals, and status updates
- Remote pairing and trusted-device flows through the relay
- Shared protocol and client types for all frontends
- Desktop shell, mobile client, remote web client, and public site in one monorepo
- Git status and diff plumbing for workspace-aware agent flows

## How It Works

FalconDeck currently has four main runtime pieces:

- a local Rust daemon
- a desktop shell around that daemon
- a relay for pairing, replay, and reconnect support
- paired remote web and mobile clients

The daemon is the system of record for runtime state. The relay is a transport and replay layer for encrypted events and RPC traffic, not the long-term source of truth for conversations.

## Host Your Own Server

You can self-host FalconDeck's server-side pieces today.

The current recommended deployment shape is:

- Ubuntu
- systemd
- Caddy
- PostgreSQL for production relay persistence
- Ansible from `ops/ansible`

The included Ansible setup can deploy:

- the relay at `connect.falcondeck.com`
- the hosted remote web app at `app.falcondeck.com`
- the public site at `falcondeck.com`

For a simple self-hosted setup, start with the examples in [`ops/ansible/README.md`](/Users/James/www/sites/falcondeck/ops/ansible/README.md). Copy the example inventory, set your host and DNS values, run the bootstrap playbook, then run the relay deploy playbook.

For more background on the production shape and relay persistence model, see [`docs/11-deployment-ops.md`](/Users/James/www/sites/falcondeck/docs/11-deployment-ops.md).

## Monorepo

- `apps/desktop` - Tauri desktop shell around the daemon
- `apps/mobile` - paired mobile client
- `apps/remote-web` - paired browser client
- `apps/site` - public marketing site
- `packages/client-core` - shared TypeScript protocol and client helpers
- `packages/ui` and `packages/chat-ui` - shared UI primitives
- `crates/falcondeck-core` - shared Rust protocol and types
- `crates/falcondeck-daemon` - local daemon and agent runtime orchestration
- `crates/falcondeck-relay` - relay for pairing, replay, and reconnect support
- `ops/ansible` - deployment and server configuration

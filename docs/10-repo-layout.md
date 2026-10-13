# Repository layout

FalconDeck is a daemon-first monorepo. The apps are clients; shared protocol
changes begin in `crates/falcondeck-core` and `packages/client-core`.

## Apps

| Directory | Purpose |
| --- | --- |
| `apps/desktop` | Tauri Mac shell and React interface |
| `apps/mobile` | React Native / Expo client for iOS and Android |
| `apps/remote-web` | Paired browser client |
| `apps/site` | Public website and mobile pairing landing page |
| `apps/extension-host` | Daemon-supervised Deno extension host |
| `apps/site-lab` | Local marketing experiments; outside the deployment path |

## Shared packages

| Directory | Purpose |
| --- | --- |
| `packages/client-core` | Client protocol types, normalization, sync, and selectors |
| `packages/ui` | Shared web primitives, themes, and styles |
| `packages/chat-ui` | Shared conversation and workspace components |
| `packages/extension-sdk` | Public extension API and types |
| `packages/extension-testing` | Fake host for testing extensions against the public API |

## Rust crates

| Directory | Purpose |
| --- | --- |
| `crates/falcondeck-core` | Shared Rust types and protocol contracts |
| `crates/falcondeck-daemon` | Agent processes, local API, event stream, and remote bridge |
| `crates/falcondeck-relay` | Pairing and encrypted replay for remote connections |

## Supporting directories

- `assets/`: source branding and repository images.
- `docs/`: [user, contributor, and maintainer documentation](README.md).
- `extensions/`: bundled official extensions and authoring instructions.
- `schemas/`: extension manifest schema.
- `scripts/`: build, release, profiling, and reliability tools.
- `ops/ansible/`: [self-hosting deployment](../ops/ansible/README.md).
- `.agents/skills/`: repository-specific coding-agent workflows.

Build outputs and local test data belong in ignored directories such as
`target/`, `dist/`, and `var/`. Real server inventory and credentials stay out of Git.

## Deployment boundaries

The daemon runs on the user's computer or an enrolled remote host. The desktop
shell embeds it; mobile and browser clients connect through a relay. Agent
session history remains in the underlying coding agent's storage.

The default public hosts are `connect.falcondeck.com` for the relay,
`falcondeck.com` for the website, and `app.falcondeck.com` for the mobile pairing
landing page. The browser client is a separate app; the default Caddy template
serves the public site on the pairing host.

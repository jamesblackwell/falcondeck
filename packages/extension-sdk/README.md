# `@falcondeck/extension-sdk`

The public TypeScript authoring surface for FalconDeck extensions. Extension
entrypoints default-export `defineExtension({ activate(context) { ... } })` and
use capability-shaped context facets instead of daemon transports or internal
application stores.

The current v0 surface is intentionally small: declared actions, declared
agent tools, thread-scoped composer suggestions, namespaced JSON storage,
bounded published views, identifier-only lifecycle events, identity, and
attributed logging. `automations:manage-owned` adds an owner-only projection and
validated effect facet over FalconDeck's existing Agent Control scheduler. An
extension can manage only its own Automations and creates them from a
daemon-verified task rather than inventing an execution target.
Event subscriptions return idempotent disposables; richer thread fields require
a separately granted read facet, and publishing tools to agents requires the
`agent-tools:register` grant.
Read `docs/EXTENSIONS.md` before adding an SDK facet; every addition needs
daemon enforcement, fake-host coverage, client fallback behavior, and an
official or example consumer.

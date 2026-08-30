# `@falcondeck/extension-sdk`

The public TypeScript authoring surface for FalconDeck extensions. Extension
entrypoints default-export `defineExtension({ activate(context) { ... } })` and
use capability-shaped context facets instead of daemon transports or internal
application stores.

The current v0 surface is intentionally small: declared actions, declared
agent tools, thread-scoped composer suggestions, namespaced JSON storage,
bounded published views, identifier-only lifecycle events, identity, and
attributed logging. The owner-only orchestration facet adds durable bounded
run reductions behind `orchestration:manage-owned-tasks`; it is not raw thread
control. Event subscriptions return idempotent disposables; richer
thread fields require a separately granted read facet, and publishing tools to
agents requires the `agent-tools:register` grant.
Read `docs/EXTENSIONS.md` before adding an SDK facet; every addition needs
daemon enforcement, fake-host coverage, client fallback behavior, and an
official or example consumer.

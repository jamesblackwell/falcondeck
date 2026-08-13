# `@falcondeck/extension-sdk`

The public TypeScript authoring surface for FalconDeck extensions. Extension
entrypoints default-export `defineExtension({ activate(context) { ... } })` and
use capability-shaped context facets instead of daemon transports or internal
application stores.

The current v0 surface is intentionally small: declared actions, namespaced
JSON storage, bounded published views, identifier-only lifecycle events,
identity, and attributed logging. Event subscriptions return idempotent
disposables; richer thread fields require a separately granted read facet.
Read `docs/EXTENSIONS.md` before adding an SDK facet; every addition needs
daemon enforcement, fake-host coverage, client fallback behavior, and an
official or example consumer.

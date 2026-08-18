# Kanban

FalconDeck's first official extension and the reference vertical slice for the
v0 public extension contract. It is bundled and enabled on new installations.

The extension gives each thread one optional named stage — Backlog, In
progress, In review, Done, Canceled, or a custom stage you add. It owns
assignments in namespaced private storage, then publishes the stage catalog
and entity-scoped `thread-tags` views. Desktop and remote web provide a
context-menu stage picker and a sidebar filter. Its trusted `app.tsx` frontend
adds a full board to desktop and remote-web navigation, with draggable thread
cards and host-owned thread navigation. Mobile renders the stage projection
read-only and shows the standard unsupported-panel fallback.

The durable extension id remains `falcondeck.thread-tags` for compatibility
with earlier colour-label data. Colour assignments are not migrated; they are
dropped on first use because a colour is not a workflow stage.

Validate and type-check it from the monorepo root:

```bash
npm run extension:validate -- extensions/official/thread-tags --json
npm run extension:frontend:typecheck
deno check --import-map=extensions/import-map.json extensions/official/thread-tags/server.ts
npm test -w @falcondeck/extension-testing -- --run src/thread-tags.test.ts
```

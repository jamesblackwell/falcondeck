# Thread Stages

FalconDeck's first official extension and the reference vertical slice for the
v0 public extension contract. It is bundled and enabled on new installations.

The extension gives each thread one optional named stage — Backlog, In
progress, In review, Done, Canceled, or a custom stage you add. It owns
assignments in namespaced private storage, then publishes the stage catalog
and entity-scoped `thread-tags` views. Desktop and remote web provide a
context-menu stage picker and a sidebar filter; mobile renders the same
projection read-only.

The durable extension id remains `falcondeck.thread-tags` for compatibility
with earlier colour-label data. Colour assignments are not migrated; they are
dropped on first use because a colour is not a workflow stage.

Validate and type-check it from the monorepo root:

```bash
npm run extension:validate -- extensions/official/thread-tags --json
deno check --import-map=extensions/import-map.json extensions/official/thread-tags/server.ts
npm test -w @falcondeck/extension-testing -- --run src/thread-tags.test.ts
```

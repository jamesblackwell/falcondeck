# Thread Colours

FalconDeck's first official extension and the reference vertical slice for the
v0 public extension contract. It is bundled and enabled on new installations.

The extension gives each thread one optional Finder-style colour, selected
without naming or creating tags. It owns assignments in namespaced private
storage, then publishes the fixed non-secret colour palette and entity-scoped
`thread-tags` views. Desktop and remote web provide an immediate context-menu
picker and render the manifest's declarative colour filter; mobile renders the
same projection read-only and visibly points users to desktop/web for filtering.

The durable extension id remains `falcondeck.thread-tags` for compatibility
with v0.1 data. On first use, old named multi-tag assignments migrate to the
colour of their first assigned tag.

Validate and type-check it from the monorepo root:

```bash
npm run extension:validate -- extensions/official/thread-tags --json
deno check --import-map=extensions/import-map.json extensions/official/thread-tags/server.ts
npm test -w @falcondeck/extension-testing -- --run src/thread-tags.test.ts
```

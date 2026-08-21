# Scratch pad

FalconDeck's official Markdown notes panel. It is bundled and enabled on new
installations. The pad is a single daemon-owned document — not a notebook of
pages — and is not sent to agents.

The trusted `app.tsx` frontend adds a Scratch pad link, with a host-owned
notebook icon, to desktop and remote-web sidebar navigation. Write or preview
Markdown; changes autosave. Mobile shows a truncated preview and the standard
unsupported-panel fallback rather than the editor.

The `notes` action is declared as a thread-menu contribution because that is
the current invokable-action surface. Clients do not render it in thread menus.

Validate and type-check it from the monorepo root:

```bash
npm run extension:validate -- extensions/official/scratch-pad --json
npm run extension:frontend:typecheck
deno check --import-map=extensions/import-map.json extensions/official/scratch-pad/server.ts
npm test -w @falcondeck/extension-testing -- --run src/scratch-pad.test.ts
```

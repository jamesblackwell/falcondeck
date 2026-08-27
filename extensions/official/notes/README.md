# Notes

FalconDeck's official Markdown notes panel. It is bundled and enabled on new
installations. Notes are daemon-owned documents and are not sent to agents.

The trusted `app.tsx` frontend adds a Notes link, with a host-owned notebook
icon, to desktop and remote-web sidebar navigation. The panel is a list column
of notes beside a single-note editor: create, search, delete, write or preview
Markdown, and changes autosave. A note's title is its first line, the way Apple
Notes derives one. Mobile shows the note titles and the standard
unsupported-panel fallback rather than the editor.

This extension replaced `falcondeck.scratch-pad` in 0.3.0. The daemon carries
persisted state over to the new id on restore, and the server folds both older
storage shapes — the single `pad` document and the pre-pad `notes` array —
forward into the `library` key on first use.

The `notes` action is declared as a thread-menu contribution because that is
the current invokable-action surface. Clients do not render it in thread menus.

Validate and type-check it from the monorepo root:

```bash
npm run extension:validate -- extensions/official/notes --json
npm run extension:frontend:typecheck
deno check --import-map=extensions/import-map.json extensions/official/notes/server.ts
npm test -w @falcondeck/extension-testing -- --run src/notes.test.ts
```

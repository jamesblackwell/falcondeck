# FalconDeck Extension Authoring

Read `../docs/EXTENSIONS.md` before changing or creating an extension.

- Import only `@falcondeck/extension-sdk`; never reach into app, daemon, SDK
  source paths, or private package modules.
- Declare every action and published view in `falcondeck.extension.json`.
- Keep private data in `context.storage`; publish only bounded, non-secret view
  projections needed by clients.
- Request no permissions unless the capability genuinely needs them.
- Run `npm run extension:validate -- <package> --json`, `deno check
--import-map=extensions/import-map.json` on the entrypoint, and the relevant
  daemon/client tests before handoff.
- Official extensions must prove public API behavior. Do not add a private
  daemon method or core thread field for their data.

Starter prompt for another coding agent:

> Build a FalconDeck extension in this repository. Read docs/EXTENSIONS.md and
> extensions/AGENTS.md, use only packages/extension-sdk, declare every action
> and view in the manifest, validate it with npm run extension:validate, and
> test persistence, disabled behavior, malformed input, and every supported
> client presentation.

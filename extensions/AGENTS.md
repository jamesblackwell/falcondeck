# FalconDeck Extension Authoring

Read `../docs/EXTENSIONS.md` before changing or creating an extension.

- Import only `@falcondeck/extension-sdk`; never reach into app, daemon, SDK
  source paths, or private package modules.
- Declare every action and published view in `falcondeck.extension.json`.
- Put declarative contribution UI in the manifest's `ui` field and use only
  the versioned public vocabulary documented in `docs/EXTENSIONS.md`;
  `defineExtensionUi` is available when constructing the same documents in TS.
- Declare a titled `panels` entry for a full-main-area surface. Desktop and web
  render the bounded document; mobile deliberately shows a visible fallback.
- Keep private data in `context.storage`; publish only bounded, non-secret view
  projections needed by clients.
- Use `context.events.on(...)` only for identifier-only lifecycle signals;
  dispose temporary subscriptions and query permission-gated facets for any
  user-visible thread data instead of assuming events contain it.
- Request no permissions unless the capability genuinely needs them.
- Run `npm run extension:validate -- <package> --json`, `deno check
--import-map=extensions/import-map.json` on the entrypoint, and the relevant
  daemon/client tests before handoff.
- Exercise backend behavior through `@falcondeck/extension-testing`; pass the
  manifest's declared action and view ids to the fake host so undeclared work,
  size limits, failures, and atomic rollback are tested.
- Official extensions must prove public API behavior. Do not add a private
  daemon method or core thread field for their data.

Starter prompt for another coding agent:

> Build a FalconDeck extension in this repository. Read docs/EXTENSIONS.md and
> extensions/AGENTS.md, use only packages/extension-sdk, declare every action
> and view in the manifest, validate it with npm run extension:validate, and
> test persistence, disabled behavior, malformed input, and every supported
> client presentation.

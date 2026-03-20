# Desktop Updates

FalconDeck desktop uses Tauri's updater plugin and GitHub Releases for the stable channel.

## Scope

This document is the maintainer reference for:

- how the desktop updater is wired
- which files are source-of-truth vs generated
- first-time setup for signing and GitHub Actions
- the stable release workflow
- common failures and how to debug them

## Release model

- The desktop shell and embedded `falcondeck-daemon` ship as one versioned desktop release.
- The updater checks GitHub Releases on startup after a short delay and then every 4 hours while the app stays open.
- Updates are downloaded as signed installer artifacts and applied on restart.

## Implementation map

Source-of-truth files:

- [Cargo.toml](/Users/James/www/sites/falcondeck/Cargo.toml): workspace version
- [package.json](/Users/James/www/sites/falcondeck/package.json): release prep scripts
- [apps/desktop/src-tauri/tauri.conf.json](/Users/James/www/sites/falcondeck/apps/desktop/src-tauri/tauri.conf.json): updater endpoint, bundled updater artifacts, embedded public key placeholder
- [apps/desktop/src-tauri/src/lib.rs](/Users/James/www/sites/falcondeck/apps/desktop/src-tauri/src/lib.rs): Tauri updater plugin registration and restart/shutdown behavior
- [apps/desktop/src/hooks/useAppUpdater.ts](/Users/James/www/sites/falcondeck/apps/desktop/src/hooks/useAppUpdater.ts): startup polling, 4-hour checks, download/install state
- [apps/desktop/src/components/SettingsView.tsx](/Users/James/www/sites/falcondeck/apps/desktop/src/components/SettingsView.tsx): user-facing updater UI
- [scripts/prepare-desktop-release.mjs](/Users/James/www/sites/falcondeck/scripts/prepare-desktop-release.mjs): sync version fields and inject the updater public key during release prep
- [release-desktop.yml](/Users/James/www/sites/falcondeck/.github/workflows/release-desktop.yml): GitHub Actions release pipeline

Generated files:

- [apps/desktop/src-tauri/gen/schemas/acl-manifests.json](/Users/James/www/sites/falcondeck/apps/desktop/src-tauri/gen/schemas/acl-manifests.json)
- [apps/desktop/src-tauri/gen/schemas/capabilities.json](/Users/James/www/sites/falcondeck/apps/desktop/src-tauri/gen/schemas/capabilities.json)
- [apps/desktop/src-tauri/gen/schemas/desktop-schema.json](/Users/James/www/sites/falcondeck/apps/desktop/src-tauri/gen/schemas/desktop-schema.json)
- [apps/desktop/src-tauri/gen/schemas/macOS-schema.json](/Users/James/www/sites/falcondeck/apps/desktop/src-tauri/gen/schemas/macOS-schema.json)

The generated schema files should change only when Tauri config or permissions change.

## First-time setup

1. Generate a Tauri updater signing keypair on a trusted machine.
2. Store the private key outside git.
3. Add the public key and signing credentials to GitHub Actions secrets.
4. Run `npm run desktop:version:sync` once to confirm the desktop package and Tauri config stay aligned with the Cargo workspace version.
5. Trigger a draft desktop release and confirm the GitHub Release contains installer assets plus updater metadata before publishing it.

## Required secrets

GitHub Actions needs these secrets before the release workflow can publish installable updates:

- `TAURI_SIGNING_PRIVATE_KEY`: the Tauri updater private key path or key contents.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: optional password for the private key.
- `FALCONDECK_UPDATER_PUBLIC_KEY`: the matching updater public key contents. This is injected into the Tauri config during release prep.

## Generating the updater keypair

Run the Tauri signer once from `apps/desktop` and store the private key safely outside git:

```bash
npm run tauri signer generate -- -w ~/.tauri/falcondeck-updater.key
```

Add the public key output to the `FALCONDECK_UPDATER_PUBLIC_KEY` GitHub secret. Add the private key to `TAURI_SIGNING_PRIVATE_KEY`.

## Versioning rules

- `[workspace.package].version` in [Cargo.toml](/Users/James/www/sites/falcondeck/Cargo.toml) is the canonical desktop release version.
- `npm run desktop:version:sync` copies that version into:
  - [package.json](/Users/James/www/sites/falcondeck/package.json)
  - [apps/desktop/package.json](/Users/James/www/sites/falcondeck/apps/desktop/package.json)
  - [apps/desktop/src-tauri/tauri.conf.json](/Users/James/www/sites/falcondeck/apps/desktop/src-tauri/tauri.conf.json)
- Do not hand-edit the desktop app version in multiple places and assume they will stay in sync.

## Releasing

1. Bump `[workspace.package].version` in [Cargo.toml](/Users/James/www/sites/falcondeck/Cargo.toml).
2. Run `npm run desktop:version:sync` from the repo root to sync the root package, desktop package, and Tauri config versions.
3. Push a tag like `desktop-v0.1.1` or run the `release-desktop` GitHub Actions workflow manually.
4. Review the draft GitHub Release and publish it when the assets look correct.

## Release checklist

Before publishing the draft release, verify:

- the tag matches the desktop version, for example `desktop-v0.1.1`
- the GitHub Actions job completed for each target platform you intend to support
- the release contains installer artifacts
- the release contains updater metadata such as `latest.json`
- the updater public key placeholder is not what was baked into the built config
- release notes are accurate enough for users to understand whether a restart is worthwhile

## Runtime behavior

Packaged FalconDeck desktop builds behave like this:

- a delayed updater check happens shortly after startup
- the app rechecks every 4 hours while it remains open
- background checks stop trying to replace an already available or already staged update
- once an update is staged, FalconDeck asks the user to restart rather than trying to hot-swap the embedded daemon

Development behavior is different:

- the updater UI remains visible
- update checks are disabled in dev builds
- dev builds should not be used to validate signed release delivery

## Troubleshooting

### The release workflow fails before build

Check:

- `FALCONDECK_UPDATER_PUBLIC_KEY` is set
- `TAURI_SIGNING_PRIVATE_KEY` is set
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is correct for the key, if a password was used

### The desktop release builds but auto-update does not work

Check:

- the published release includes updater metadata such as `latest.json`
- the updater endpoint in [apps/desktop/src-tauri/tauri.conf.json](/Users/James/www/sites/falcondeck/apps/desktop/src-tauri/tauri.conf.json) still points at the correct GitHub Releases URL
- the embedded updater public key matches the private key that signed the release
- the desktop app version is newer than the currently installed version

### FalconDeck says updates are unavailable

Check:

- whether the app is a packaged desktop build or a dev build
- whether the updater plugin is enabled in [apps/desktop/src-tauri/src/lib.rs](/Users/James/www/sites/falcondeck/apps/desktop/src-tauri/src/lib.rs)
- whether the updater permission is present in [apps/desktop/src-tauri/capabilities/default.json](/Users/James/www/sites/falcondeck/apps/desktop/src-tauri/capabilities/default.json)

### Local desktop builds fail on missing native npm bindings

This repo has hit npm optional dependency issues with native Tauri, Rollup, and Rolldown binaries on some machines.

Check:

- the correct platform-specific optional packages are installed under `apps/desktop/node_modules`
- you are using a consistent Node/npm architecture
- a fresh install resolves the missing binary package before assuming the app code is broken

### A release cut from CI still contains the public key placeholder

That means `FALCONDECK_UPDATER_PUBLIC_KEY` was not injected during release prep. Do not publish that release as a desktop auto-update target.

## Local notes

- Development builds keep the updater UI visible but do not hit GitHub Releases.
- If the updater public key placeholder is still present, packaged release builds should not be considered shippable.

## Related docs

- [10-repo-layout.md](/Users/James/www/sites/falcondeck/docs/10-repo-layout.md)
- [11-deployment-ops.md](/Users/James/www/sites/falcondeck/docs/11-deployment-ops.md)
- [06-architecture-decisions.md](/Users/James/www/sites/falcondeck/docs/06-architecture-decisions.md)

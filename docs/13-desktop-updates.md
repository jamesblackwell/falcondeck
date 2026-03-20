# Desktop Updates

FalconDeck desktop uses Tauri's updater plugin and GitHub Releases for the stable channel.

## Release model

- The desktop shell and embedded `falcondeck-daemon` ship as one versioned desktop release.
- The updater checks GitHub Releases on startup after a short delay and then every 4 hours while the app stays open.
- Updates are downloaded as signed installer artifacts and applied on restart.

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

## Releasing

1. Bump `[workspace.package].version` in [Cargo.toml](/Users/James/www/sites/falcondeck/Cargo.toml).
2. Run `npm run desktop:version:sync` from the repo root to sync the root package, desktop package, and Tauri config versions.
3. Push a tag like `desktop-v0.1.1` or run the `release-desktop` GitHub Actions workflow manually.
4. Review the draft GitHub Release and publish it when the assets look correct.

## Local notes

- Development builds keep the updater UI visible but do not hit GitHub Releases.
- If the updater public key placeholder is still present, packaged release builds should not be considered shippable.

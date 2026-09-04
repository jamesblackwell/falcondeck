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
- [apps/desktop/src-tauri/tauri.conf.json](/Users/James/www/sites/falcondeck/apps/desktop/src-tauri/tauri.conf.json): updater endpoint, bundled updater artifacts, embedded public key placeholder, macOS entitlements
- [apps/desktop/src-tauri/entitlements.plist](/Users/James/www/sites/falcondeck/apps/desktop/src-tauri/entitlements.plist): Hardened Runtime entitlements for WebView JIT and microphone access
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

Two separate signing systems are required for a downloadable Mac build:

1. **Apple Developer ID + notarization** so Gatekeeper will open the DMG. This uses the same paid Apple Developer team as the iOS App Store app. It is *not* the iOS Distribution certificate EAS already uses.
2. **Tauri updater keys** so later desktop releases can be verified by already-installed apps.

The iOS app and `com.falcondeck.desktop` can share one team. They cannot share one certificate. Only the Apple Developer **Account Holder** can create a Developer ID Application certificate.

### Apple account (Account Holder)

Do this on the Mac that should also sign local `make desktop-install` builds:

1. Sign in to [developer.apple.com](https://developer.apple.com/account) with the **paid team** that owns the FalconDeck iOS app. Do not use the free personal team.
2. In Keychain Access: Certificate Assistant → Request a Certificate From a Certificate Authority. Save a CSR to disk. Use your email, leave CA email empty, choose Saved to disk.
3. [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list) → + → **Developer ID Application** → G2 (or the current default) → upload the CSR.
4. Download the `.cer`, double-click it so it lands in the login keychain under My Certificates, and confirm:

   ```bash
   security find-identity -v -p codesigning
   ```

   You want a line like `Developer ID Application: Version Zero Limited (TEAMID)`.
5. Export that identity as a `.p12` (right-click the private key under the certificate) and set a password.
6. Create an App Store Connect API key for notarization: [Users and Access → Integrations → Team Keys](https://appstoreconnect.apple.com/access/integrations/api) → Generate → **Developer** or **App Manager**. Download the `.p8` once. Note the Key ID and Issuer ID. The Team ID is on [Membership](https://developer.apple.com/account#MembershipDetailsCard).

Then put those values in GitHub Actions secrets (never commit them):

```bash
openssl base64 -A -in /path/to/developer-id.p12 | gh secret set APPLE_CERTIFICATE
gh secret set APPLE_CERTIFICATE_PASSWORD   # .p12 password
gh secret set APPLE_TEAM_ID --body 'TEAMID'
gh secret set APPLE_API_ISSUER --body 'issuer-uuid'
gh secret set APPLE_API_KEY --body 'KEYID'
gh secret set APPLE_API_KEY_P8 < /path/to/AuthKey_KEYID.p8
```

Apple ID + app-specific password (`APPLE_ID`, `APPLE_PASSWORD`) is an alternative to the API key. Prefer the API key.

### Tauri updater keys

Run the Tauri signer once from `apps/desktop` and store the private key outside git:

```bash
npm run tauri signer generate -- -w ~/.tauri/falcondeck-updater.key
```

Add the public key output to `FALCONDECK_UPDATER_PUBLIC_KEY`. Add the private key to `TAURI_SIGNING_PRIVATE_KEY`, and its password to `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

Then:

1. Run `npm run desktop:version:sync` once to confirm the desktop package and Tauri config stay aligned with the Cargo workspace version.
2. Trigger a draft desktop release and confirm the GitHub Release contains installer assets plus updater metadata before publishing it.
3. Install that DMG on a Mac that did not build it and confirm Gatekeeper is silent before publishing.

## Required secrets

GitHub Actions needs these secrets before the release workflow can publish installable Mac builds:

- `TAURI_SIGNING_PRIVATE_KEY`: the Tauri updater private key contents.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: password for that private key.
- `FALCONDECK_UPDATER_PUBLIC_KEY`: the matching updater public key contents. This is injected into the Tauri config during release prep.
- `APPLE_CERTIFICATE`: base64 of the Developer ID Application `.p12`.
- `APPLE_CERTIFICATE_PASSWORD`: password for that `.p12`.
- `APPLE_TEAM_ID`: 10-character Apple team ID.
- `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_P8`: App Store Connect API key for notarization.

`APPLE_ID` and `APPLE_PASSWORD` (an [app-specific password](https://support.apple.com/en-ca/HT204397), not the account password) can replace the API key trio.

## Versioning rules

- `[workspace.package].version` in [Cargo.toml](/Users/James/www/sites/falcondeck/Cargo.toml) is the canonical desktop release version.
- `npm run desktop:version:sync` copies that version into:
  - [package.json](/Users/James/www/sites/falcondeck/package.json)
  - [apps/desktop/package.json](/Users/James/www/sites/falcondeck/apps/desktop/package.json)
  - [apps/desktop/src-tauri/tauri.conf.json](/Users/James/www/sites/falcondeck/apps/desktop/src-tauri/tauri.conf.json)
- Do not hand-edit the desktop app version in multiple places and assume they will stay in sync.

## Releasing

GitHub Actions secrets and the Mac-only notarizing workflow are already in place. First public version is `0.1.0` (no bump needed). After the current working-tree work is on `main`:

1. Rebase or merge `origin/main`, then push `main`.
2. `git tag desktop-v0.1.0 && git push origin desktop-v0.1.0` (or run the `release-desktop` workflow manually). That creates a **draft** GitHub Release.
3. Wait for both macOS jobs (Apple Silicon and Intel). Confirm the draft has `.dmg` / `.app.tar.gz` assets and `latest.json`.
4. Install from that DMG (not `make desktop-install`) and confirm Gatekeeper is silent, the daemon starts, and one real agent turn works.
5. Publish the draft. Then update the README “until the first build is available” copy.

Later cuts: bump `[workspace.package].version` in [Cargo.toml](/Users/James/www/sites/falcondeck/Cargo.toml), run `npm run desktop:version:sync`, tag `desktop-vX.Y.Z`.

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
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is correct for the key
- `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, and `APPLE_TEAM_ID` are set
- notarization credentials are set (API key or Apple ID)

The imported certificate must be **Developer ID Application**, not Apple Distribution or iOS Distribution. Those iOS/App Store certs cannot sign a GitHub Releases DMG.

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

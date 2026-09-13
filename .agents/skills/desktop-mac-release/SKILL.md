---
name: desktop-mac-release
description: Cut, watch, and publish a signed notarized FalconDeck Mac GitHub Release (DMG). Use when asked to ship, release, tag, or publish the Mac/desktop app, a desktop-v* tag, a downloadable DMG, or GitHub Releases for desktop.
---

# Desktop Mac release

Read [docs/13-desktop-updates.md](../../../docs/13-desktop-updates.md) for signing setup, secrets, updater wiring, and troubleshooting. This skill is the agent procedure.

Do not ship an unsigned zip. Gatekeeper blocks internet-downloaded Mac apps that are not Developer ID–signed and notarized.

## Preconditions

- GitHub Actions secrets already exist (names only via `gh secret list`): `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_API_ISSUER`, `APPLE_API_KEY`, `APPLE_API_KEY_P8`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `FALCONDECK_UPDATER_PUBLIC_KEY`.
- Workflow is [release-desktop.yml](../../../.github/workflows/release-desktop.yml): macOS Apple Silicon + Intel only.
- Canonical version is `[workspace.package].version` in [Cargo.toml](../../../Cargo.toml). Tag must be `desktop-v` plus that version.
- Do not include unrelated dirty work. Do not rewrite a tag that already has a **published** GitHub Release.

## Cut a release

1. If this is not a retag of an unpublished draft, bump `Cargo.toml` and run `npm run desktop:version:sync`.
2. Push the intended `main`.
3. `git tag desktop-vX.Y.Z && git push origin desktop-vX.Y.Z` (creates a **draft** release).
4. Watch both `publish-tauri` jobs. Use [scripts/watch-release.sh](scripts/watch-release.sh) `<run-id>` plus the long-running-background-tasks `monitor` tool. Do not poll in the agent loop.
5. Confirm the draft has `FalconDeck_*_aarch64.dmg`, `FalconDeck_*_x64.dmg`, `FalconDeck_{aarch64,x64}.app.tar.gz` plus `.sig`, and `latest.json` with `darwin-aarch64` and `darwin-x86_64`.
6. Download a DMG from the draft (not `make desktop-install`). Gatekeeper must be silent; daemon starts; one real Codex or Claude turn works.
7. `gh release edit desktop-vX.Y.Z --draft=false`.
8. Point README (and site copy if it still says “coming soon”) at the release URL.

Return the release URL. Use the `ntfy` skill when CI was long or James asked to be notified.

## Fragile rules

- Do not pass `APPLE_ID` / `APPLE_PASSWORD` into `tauri-action` unless those secrets are actually set. Empty strings make Tauri use Apple-ID auth and notarization returns 401.
- Packaged builds use `npm run build:frontend` (Vite). `npm run build` / `tsc -b` is not the release gate.
- ObjC `@available` needs `libclang_rt.osx` linked from [apps/desktop/src-tauri/build.rs](../../../apps/desktop/src-tauri/build.rs). Missing it fails release link with `___isPlatformVersionAtLeast`.
- Never commit `.p12`, `.p8`, or updater private keys. Local copies live under `~/.tauri/`; Doppler project `falcondeck` / `prd` is the backup.

## First-time signing

If secrets are missing, stop. Account Holder creates a **Developer ID Application** cert (not iOS/App Store Distribution). Steps are in docs/13. Do not invent credentials.

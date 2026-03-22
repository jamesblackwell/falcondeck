# Mobile App (React Native / Expo)

Last updated: 2026-03-21

## Overview

`apps/mobile` is a React Native app built with Expo SDK 54. It connects to the desktop daemon via the FalconDeck relay, providing full remote control of agent workspaces from iOS.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | React Native 0.81, Expo SDK 54 |
| Navigation | Expo Router 6 (file-based) |
| Styling | react-native-unistyles v3 (Nitro Modules) |
| Animations | react-native-reanimated v4 |
| State | Zustand 5 (relay, session, UI stores) |
| Storage | react-native-mmkv (fast KV), expo-secure-store (keys) |
| Crypto | @noble/ciphers, tweetnacl (E2E encryption) |
| Lists | @shopify/flash-list v2 |
| Icons | lucide-react-native |

## Architecture

```
Mobile App
  ├── Relay Store (WebSocket connection, encryption, RPC)
  ├── Session Store (workspace/thread state, conversation items)
  ├── UI Store (draft, model/effort selection)
  └── Hooks
      ├── useRelayConnection (WebSocket lifecycle)
      ├── useSessionActions (submitTurn, respondApproval, loadThreadDetail)
      ├── useRenderBlocks (conversation items → render blocks)
      ├── useScrollToBottom (scroll tracking + FAB)
      └── useInterruptTurn (stop button RPC)
```

## Monorepo Integration

The mobile app lives in an npm workspaces monorepo. **Critical details:**

- Package manager: **npm** (not pnpm). The root `package-lock.json` is the source of truth.
- The root also has a `pnpm-lock.yaml` from historical usage — **ignore it**.
- Shared code: `@falcondeck/client-core` (workspace package at `packages/client-core`).
- The root `node_modules` has different React/RN versions (for desktop). The mobile app's `metro.config.js` **blocklists** the root copies to prevent duplicate bundling.

### After changing dependencies

```bash
# From monorepo root — ALWAYS do this after touching any package.json
npm install

# Verify lockfile is in sync
npm ci --dry-run
```

Never use `pnpm add` in the mobile app — it destroys the npm-managed node_modules.

## Development

### Simulator

```bash
make mobile-dev
```

This boots the iOS Simulator, starts Metro, builds the native binary, and launches the app.

### Manual steps

```bash
cd apps/mobile

# Start Metro
npx expo start --clear

# Prebuild native project (after changing native deps or plugins)
npx expo prebuild --platform ios --clean

# Build for simulator
cd ios && xcodebuild -workspace FalconDeck.xcworkspace \
  -scheme FalconDeck -configuration Debug \
  -sdk iphonesimulator -destination "id=$(xcrun simctl list devices booted -j | jq -r '.devices[][] | select(.state=="Booted") | .udid' | head -1)" \
  -derivedDataPath .derivedData \
  IPHONEOS_DEPLOYMENT_TARGET=16.0 \
  build

# Install to simulator
xcrun simctl install booted ios/.derivedData/Build/Products/Debug-iphonesimulator/FalconDeck.app
```

### Tests

```bash
make mobile-test
# or
cd apps/mobile && npx vitest run
```

## Building & Deploying

### EAS Cloud Build (ad-hoc — direct install link)

```bash
make mobile-build
# or
cd apps/mobile && eas build --profile preview --platform ios
```

Opens an interactive prompt to set up ad-hoc credentials (first time only). Produces a direct install link — tap it on your phone, no TestFlight needed.

### EAS Cloud Build (TestFlight)

```bash
cd apps/mobile && eas build --profile preview-testflight --platform ios --non-interactive
cd apps/mobile && eas submit --profile preview-testflight --platform ios --latest --non-interactive
```

### OTA Updates (JS-only, instant)

After a native build is installed, push JS updates without rebuilding:

```bash
make mobile-deploy MSG="description of changes"
# or
cd apps/mobile && eas update --branch preview-testflight --message "update description"
```

OTA only works if the native binary hasn't changed. If you added native modules, changed `app.config.ts` plugins, or modified `Podfile.properties.json`, you need a full build.

## Native Module Gotchas

### react-native-unistyles v3

- Requires the Babel plugin: `["react-native-unistyles/plugin", { root: __dirname }]`
- Uses Nitro Modules (C++/Swift interop via `react-native-nitro-modules`)
- `react-native-nitro-modules` must be a **direct dependency** in `package.json` — otherwise auto-linking won't register the `NitroModules` pod and `pod install` fails with "Unable to find a specification for NitroModules"

### react-native-mmkv

- Uses zlib's `_crc32` function but doesn't declare `libz` in its podspec
- When `react-native-nitro-modules` is a direct dep, the pod graph changes and `libz` is no longer transitively linked
- Fixed via `plugins/withLibz.js` config plugin that adds `-lz` to the app target's `OTHER_LDFLAGS`

### Duplicate React/RN in monorepo

- The monorepo root has newer versions of `react`, `react-dom`, `react-native` (for the desktop app)
- Without intervention, Metro bundles BOTH the local and root copies
- This causes `TypeError: property is not writable` crashes on launch
- Fixed via `metro.config.js` `resolver.blockList` that excludes the root copies

## Key Config Files

| File | Purpose |
|------|---------|
| `app.config.ts` | Expo config (plugins, splash, bundle ID, EAS project) |
| `babel.config.js` | Babel plugins (unistyles, reanimated) |
| `metro.config.js` | Metro bundler config (monorepo paths, React dedup) |
| `eas.json` | EAS Build profiles (preview, testflight, production) |
| `ios/Podfile.properties.json` | CocoaPods settings (Hermes, New Arch) |
| `plugins/withLibz.js` | Config plugin to link libz for MMKV |

## EAS Build Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Install dependencies" fails | `package-lock.json` out of sync | Run `npm install` from monorepo root |
| "Install pods" fails with NitroModules | `react-native-nitro-modules` not in package.json | Add it as a direct dependency |
| `_crc32` linker error | Missing `libz` linkage | Ensure `plugins/withLibz.js` is in app.config.ts plugins |
| `TypeError: property is not writable` on launch | Duplicate react-native in bundle | Check `metro.config.js` blockList covers root copies |
| `Incompatible React versions` | Root react differs from local | `metro.config.js` blockList should handle this |
| Xcode 26 SDK errors | EAS defaulted to beta Xcode | Pin `ios.image` in eas.json |

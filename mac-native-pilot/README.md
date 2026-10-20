# FalconDeck Native for Mac

A SwiftUI/AppKit Mac client for FalconDeck, with the existing Rust daemon as its
runtime. The native iOS app is the starting design reference; this implementation
adds the desktop's project and task sidebars, chats, pins, conversation tools,
settings, remote hosts, file and Git inspector, terminal, extensions and speech.

This is an implementation under integration, not a declaration of complete
feature parity. The [implementation and verification matrix](IMPLEMENTATION.md)
records what is present and what has been exercised. The original
[feature parity plan](FEATURE-PARITY-PLAN.md) describes the intended coverage.

## Runtime and data

The app attaches to a healthy FalconDeck daemon already running on this Mac,
including the packaged desktop app's temporary loopback port. It leaves that
runtime running when it quits. If no other runtime is present, the packaged app
starts the Rust daemon through its bundled `falcondeck-native-host` library.
Quitting an owned runtime checks for active tasks and shuts down the daemon.
Runtime discovery and a shared state lock prevent two new runtimes from owning
the same persisted state.

The daemon and underlying agents remain authoritative for sessions and history.
The native client does not introduce a conversation database. Recoverable drafts,
attachment payloads and pending submissions are stored separately in an AES-GCM
encrypted `input.enc` file under `~/Library/Application Support/FalconDeck Native`;
the encryption key is stored in this app's Keychain namespace. Appearance and
shortcut preferences are local to this Mac. Remote credentials also use Keychain.

An optional `FALCONDECK_DAEMON_URL` explicitly selects a loopback HTTP daemon,
for example `http://127.0.0.1:4123`. An unavailable explicit address produces an
error instead of silently starting another runtime. Remote machines use the
encrypted relay pairing flow in Servers. Available remote actions follow the
daemon's registered relay RPCs; terminal sessions are currently local only.

## Appearance

The default uses the native Mac system font and system monospaced font, with
comfortable text sizes and a slightly enlarged default scale. Appearance settings
include all 19 light and dark palettes, system/light/dark modes, separate UI,
conversation and code font choices, installed custom fonts, weights, global text
scale and separate sidebar, chat and code scales. Missing custom fonts fall back
to the system font. Theme text colors are adjusted for readable contrast, with
additional support for macOS Increase Contrast.

## Build and run

Requires macOS 14 or later, Xcode with the Swift 6 toolchain selected, Rust/Cargo,
Node.js and the repository's npm dependencies. From the repository root:

```sh
npm install
npm run extension-runtime:prepare
npm run computer-use-runtime:prepare
npm run parakeet-runtime:prepare
./mac-native-pilot/scripts/build-app.sh --open
```

The preparation commands provide the architecture-specific Deno, computer-use
driver and Parakeet helper used by the package script. The script builds the
extension compatibility resources, Rust host and Swift executable, bundles their
resources and frameworks, and signs
`mac-native-pilot/build/FalconDeck Native.app`. Without `--open`, it only builds.
Use `--debug` for a development build.

To install alongside the existing desktop app:

```sh
./mac-native-pilot/scripts/build-app.sh --install --open
```

The installation path is `/Applications/FalconDeck Native.app`, with bundle
identifier `com.falcondeck.mac-native-pilot`. The script replaces only an app with
that identifier; it does not replace `FalconDeck.app`. The default ad hoc signed
build is for local development and is not notarized for distribution.
`FALCONDECK_NATIVE_SIGNING_IDENTITY` selects a signing identity, and
`FALCONDECK_NATIVE_CARGO_TARGET_DIR` overrides the default Rust build directory
`/tmp/falcondeck-native-runtime-target`.

## Development

Open `Package.swift` in Xcode, or use:

```sh
swift build --package-path mac-native-pilot
swift test --package-path mac-native-pilot
```

Swift Package Manager resolves Sodium, SwiftTerm and Sparkle. The native speech
bridge is an Objective-C target. A plain Swift build can attach to a running
daemon; use the packaging script to include the Rust runtime and its helpers for
standalone operation. `FALCONDECK_NATIVE_HOST_LIBRARY` can select a host library
for development. A `FALCONDECK_STATE_PATH` in a separate directory requests an
isolated embedded runtime; changing only the filename within the normal state
directory does not isolate the auxiliary stores.

Sources are in `Sources/FalconDeckMac` and `Sources/NativeSpeechBridge`; focused
tests are in `Tests/FalconDeckMacTests`. The Rust bridge is in
[`crates/falcondeck-native-host`](../crates/falcondeck-native-host). The reference
iOS app is in [`ios-native-pilot`](../ios-native-pilot). Build output is ignored.
The encrypted remote integration test requires explicit isolated loopback daemon
and relay endpoints and skips in an ordinary test run.

Real sends start or continue actual agent work. Use a disposable task when
checking the composer and streaming behavior. Microphone, speech recognition,
Accessibility, Screen Recording and browser access use the appropriate macOS and
FalconDeck consent flows; building the app does not grant them.

## Native updates

The app uses Sparkle with a separate native appcast and signing key. Configure
both when packaging a build intended to receive updates:

```sh
export FALCONDECK_NATIVE_UPDATE_FEED_URL='https://example.com/native/appcast.xml'
export FALCONDECK_NATIVE_UPDATE_PUBLIC_KEY='<base64 Ed25519 public key>'
./mac-native-pilot/scripts/build-app.sh
```

The script requires an HTTPS appcast and a base64 encoded 32-byte public key.
The native app does not use the Tauri JSON update feed. Local builds without a
configured native feed show that updates are unavailable. No native production
feed or end-to-end update installation is established by this implementation.

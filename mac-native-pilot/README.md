# FalconDeck Native for Mac

A small SwiftUI Mac client for the existing FalconDeck daemon, using the native
iOS pilot as a design reference. It is a prototype for browsing real projects
and tasks and sending and receiving agent messages. Settings, speech, and the
full desktop feature set are outside this prototype.

The [feature parity plan](FEATURE-PARITY-PLAN.md) maps the current desktop app to
the proposed native layout, settings, platform services and implementation milestones.

The Rust daemon and native agent histories remain authoritative. This app uses
the daemon already running on your Mac; it does not launch, stop, or restart the
daemon. Keep your existing FalconDeck desktop app running while trying it.

The project sidebar shows real project workspaces; standalone chats are outside
this pilot. Tasks support native Markdown and code blocks, tool disclosures,
earlier history, text messages, interruption, and basic approvals/questions.
New tasks use the selected harness and its existing daemon defaults. Settings,
attachments, speech, extensions, and remote pairing are outside this pilot.

Connection is automatic, including the packaged app's temporary local port.
For a development daemon, an optional `FALCONDECK_DAEMON_URL` environment variable
accepts a loopback HTTP URL such as `http://127.0.0.1:4123`. The pilot never sends
to an external daemon address. Drafts live in memory for this prototype.

## Build and run

Requires macOS 14 or later and Xcode with the Swift 6 toolchain selected.
From the repository root:

```sh
./mac-native-pilot/scripts/build-app.sh --open
```

This builds a release executable and packages it in
`mac-native-pilot/build/FalconDeck Native.app` with the existing FalconDeck icon
and an ad hoc signature. Without `--open`, the script only builds the app.
Use `--debug` for a faster development build.

To install it alongside the production app:

```sh
./mac-native-pilot/scripts/build-app.sh --install --open
```

The installation path is `/Applications/FalconDeck Native.app`; the separate
bundle identifier is `com.falcondeck.mac-native-pilot`. The script only replaces
an installed app with that identifier. It never changes `FalconDeck.app`.
This local prototype is not notarized for distribution.

## Development

The app is a Swift package, with no Xcode project or third-party dependencies.
Open `mac-native-pilot/Package.swift` in Xcode, or use:

```sh
swift build --package-path mac-native-pilot
swift test --package-path mac-native-pilot
```

Sources live in `Sources/FalconDeckMac`; focused protocol and state tests live
in `Tests/FalconDeckMacTests`. Build output stays ignored inside this directory.
The reference iOS app lives in `ios-native-pilot`.

Real sends start or continue actual agent work. Use a disposable task when
checking the composer and streaming behavior.

Initial local verification: a release app was built and installed alongside the
desktop app, real project/task history loaded, and a new Codex task sent a
message and displayed its live reply. Focused transport/state tests passed.

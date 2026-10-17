# Falcon Native

Standalone SwiftUI development client for iPhone and iPad (iOS 26+). It uses the
existing encrypted relay and daemon RPCs. The app and speech widget have separate
bundle identifiers from the released app; they can be installed alongside it.
Production clients, daemon, relay, Expo, OTA and TestFlight are unchanged.

## Run locally

Requires Xcode, an iOS 26+ simulator runtime, and XcodeGen.

```sh
cd ios-native-pilot
./scripts/run.sh         # restore saved pairing or show welcome
./scripts/run.sh --demo  # sample projects and local replies
```

Set `SIMULATOR_UDID` to use a specific simulator. The default script reuses
**FalconDeck Native Pilot** and leaves other simulators alone. Open
`FalconDeckNative.xcodeproj` to run in Xcode. Regenerate it with `xcodegen generate`
after adding files or editing `project.yml`. Keep simulator signing enabled:
`CODE_SIGNING_ALLOWED=NO` prevents Keychain access.

## Install on a development device

```sh
./scripts/install-device.sh <paired-device-identifier>
```

The script builds Debug with Apple Development signing, then installs and
launches **Falcon Native** using `devicectl`. A paired device on the same Wi-Fi
network works without a cable when Developer Mode is enabled and the device is
reachable/unlocked. Use `xcrun devicectl list devices` to find it. Set
`DEVELOPMENT_TEAM` if a different development team is needed. There is no archive,
upload, distribution, TestFlight or deployment step.

The device build includes the native speech Live Activity extension. Build output
is in `build-device/Build/Products/Debug-iphoneos/FalconDeckNative.app`.

## Connect

Create a signed pairing link in the desktop app's remote-access settings. In
Falcon Native, open Connections and scan the QR code or paste the complete link.
The default relay is `https://connect.falcondeck.com`; a relay in the signed link
is honored. This registers a separate trusted client named **Falcon Native
Pilot**. It does not reuse the released mobile app's credentials.

The app owns `falcondeck-native://` links. HTTPS pairing links can be pasted or
scanned without intercepting the released app's links. Do not put pairing links,
keys, tokens, real device inventory or private screenshots in git.

## Included

- Conversation-first navigation, adaptive sidebar, casual chats, projects,
  global/project pins, synced folders, archive reading/restoration, project order,
  visibility and icon choices, task sort, filters and lazy paging.
- Draft-first task creation; provider/model/effort/mode/permissions/sandbox/speed;
  slash skills and saved prompts; queue/edit/remove/steer; interrupt/resume;
  rename/suggest title; read/unread; goals and context compaction.
- Edit/retry in a new branch and cross-agent handoff. Handoff leaves the source
  task intact and holds context at the daemon until the first destination send.
- Live Markdown, code highlighting/copy, tables, reasoning/tool groups,
  display preferences, plans/diffs/files, citations, images, artifacts,
  operational notices, token usage and inspectable unknown items.
- Photos/camera/files/clipboard image attachments; native image preview,
  zoom/save/share; full tool-output sheets and explicit partial transcript export.
- Retained voice recordings, on-device recognition, computer transcription,
  system/computer read aloud, speech Live Activities and Lock Screen/headset
  playback controls; bounded native realtime PCM audio.
- Automations: list/create/edit/pause/resume/delete/run/history using control RPC,
  revision checks and idempotency keys. Demo actions never start a real agent.
- Settings: all 19 shared theme palettes, text size/Dynamic Type, conversation,
  connected alerts, speech, connection diagnostics, about and developer tools.
- Extension stages, declarative filters/panels and follow-up suggestions. Buttons
  submit a suggestion independently of the user's unsent draft and images.

SwiftUI/UIKit/ActivityKit render the interface. CryptoKit and
[Swift-Sodium 0.11.0](https://github.com/jedisct1/swift-sodium) implement the existing
crypto protocol. [MarkdownUI 2.4.1](https://github.com/gonzalezreal/swift-markdown-ui)
renders Markdown. No JavaScript runtime, React Native bridge or webview ships in
the app. `scripts/sync-palettes.mjs` reads the existing mobile theme source to
refresh the checked-in native palette catalog.

## Recovery and boundaries

Keychain holds this client's identity and relay credentials. Unsent text, image
attachments, composer choices and the last conversation selection are encrypted
per pairing in protected device files. Conversations remain in memory; the
daemon and native agent storage are authoritative. Forget removes this pairing's
input files and credentials. Revoke the trusted device from desktop settings if
it should no longer connect.

Connections bootstrap through `sync.index`, expand shared catalogs once, and
page project/folder lists with `sync.threads`. A legacy snapshot fallback is used
only when compact sync is unavailable. Live events stream immediately; sidebar
metadata is coalesced. Fresh snapshots, connection identities, touched-row/view
tracking and UTF-16 offsets protect reconnects and paged history. Network retry
uses bounded backoff. Mutations and uncertain sends are never retried automatically.
Search covers loaded tasks and explicitly offers loading more.

Known limits:

- Background remote push is unavailable: the current relay only delivers Expo
  push. A native APNs relay path requires separate server work/deployment. James
  was notified via NTFY; production was left untouched. Opt-in connected local
  alerts work while the app can maintain its connection. They cannot detect
  desktop activity.
- Common Mermaid flowcharts render as native shapes. Other Mermaid syntax shows
  its complete copyable source. Code coloring is lightweight.
- Extensions must publish supported declarative mobile UI. Desktop frontend
  panels have an explicit desktop fallback.
- Camera, microphone, speech languages and Live Activity behavior still need
  verification on unlocked physical devices. Wi-Fi installation on the iPhone
  succeeded; launching it requires unlocking. The physical iPad needs unlocking
  before its development image can mount and installation can proceed.

## Verify

```sh
xcodebuild -project FalconDeckNative.xcodeproj -scheme FalconDeckNative \
  -destination 'platform=iOS Simulator,name=FalconDeck Native Pilot' \
  -derivedDataPath build test

xcodebuild -project FalconDeckNative.xcodeproj -scheme FalconDeckNativeUI \
  -destination 'platform=iOS Simulator,name=FalconDeck Native iPad' \
  -derivedDataPath build-ui test
```

The final run has 85 passing unit tests and passing chat/automation UI checks on
both phone and tablet simulators. See [VERIFICATION.md](VERIFICATION.md) for the
review and device handoff, and [PARITY.md](PARITY.md) for the feature ledger. Tests cover
crypto interoperability, pairing authority, chunks/ACKs, UTF-16 streaming,
connection races, history recovery, drafts, queues, control revisions,
attachments, PCM, handoff, extension replacement/tombstones, theme callbacks and
native flowchart parsing. Simulator screenshots and build products stay in
ignored local `artifacts/` and `build*/` directories.

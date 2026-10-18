# Falcon Native

Standalone SwiftUI development client for iPhone and iPad (iOS 26+). It uses the
existing encrypted relay and daemon RPCs. The app and speech widget have separate
bundle identifiers from the released app; they can be installed alongside it.
The released clients and daemon are unchanged. The relay now supports optional
native APNs alongside its existing Expo provider; no Expo build, OTA or
TestFlight submission is involved.

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
Falcon Native, scan the QR code on the opening screen to connect automatically,
or paste the complete code/link and tap Connect. Setup remains visible until
the encrypted workspace is ready. A self-hosted relay gets the same explicit
server review as the Expo client; diagnostics and forgetting a saved computer
are in Settings → Connections. The default relay is `https://connect.falcondeck.com`; a relay in the signed link
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
- Inline voice recording/transcribing with waveform, timer, stop-to-edit,
  transcribe-and-send and retained audio for retry. New recordings default to the
  same OpenRouter transcription service/model as Expo, through the paired computer;
  explicit on-device choices and older recordings retain their selected engine.
  Also includes on-device recognition, computer transcription,
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
per pairing in protected device files. A separate encrypted, disposable cache
restores projects, up to 200 task summaries and five recent conversation tails
on relaunch. Each tail holds at most 150 items / 64 KiB. Model catalogs have a
separate bound of 32 workspace/harness entries, 1,000 models / 256 KiB per entry
and 1 MiB total. Last-known models keep the picker usable while live metadata
hydrates; nonempty live lists always win. Skills, plans, diffs, pending sends
and active approvals are excluded. New-task choices are remembered separately
per workspace and harness, with access modes checked against current capabilities. Cached history remains visible
while fresh history loads, and cannot automatically mark a task read until that
refresh succeeds. No replay cursor or sync token is restored from this cache.
The daemon and native agent storage remain authoritative. Forget removes this
pairing's cache, input files and credentials. Revoke the trusted device from desktop settings if
it should no longer connect.

Connections bootstrap through `sync.index`, expand shared catalogs once, and
page project/folder lists with `sync.threads`. A legacy snapshot fallback is used
only when compact sync is unavailable. Live events stream immediately; sidebar
metadata is coalesced. Fresh snapshots, connection identities, touched-row/view
tracking and UTF-16 offsets protect reconnects and paged history. Network retry
uses bounded backoff. Mutations and uncertain sends are never retried automatically.
Search covers loaded tasks and explicitly offers loading more.

Known limits:

- Native background push is opt-in under Settings → Notifications. The real
  relay advertises this development app’s sandbox APNs topic alongside Expo.
  Token registration and Apple authentication were verified; a delivered banner
  on physical hardware still needs testing. Self-hosters must configure their
  own Apple credentials/topics; see [the public push contract](../docs/push-client-protocol.md).
- Common Mermaid flowcharts render as native shapes. Other Mermaid syntax shows
  its complete copyable source. Code coloring is lightweight.
- Extensions must publish supported declarative mobile UI. Desktop frontend
  panels have an explicit desktop fallback.
- Camera, microphone, speech languages and Live Activity behavior still need
  verification on unlocked physical devices. Wi-Fi installation on the iPhone
  and launch succeeded. The physical iPad needs unlocking
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

The latest unit run has 199 passing tests. Pairing/chat/automation UI checks have
passed on both phone and tablet simulators. See [VERIFICATION.md](VERIFICATION.md) for the
review and device handoff, and [PARITY.md](PARITY.md) for the feature ledger. Tests cover
crypto interoperability, pairing authority, chunks/ACKs, UTF-16 streaming,
connection races, history recovery, drafts, queues, control revisions,
attachments, PCM, handoff, extension replacement/tombstones, theme callbacks and
native flowchart parsing. Simulator screenshots and build products stay in
ignored local `artifacts/` and `build*/` directories.

The visual polish pass follows the Mac/Expo hierarchy and includes phone, iPad,
compact-width and accessibility-text captures. See [VISUAL-QA.md](VISUAL-QA.md)
for the screen inventory, findings and device status.

See [LOADING-QA.md](LOADING-QA.md) for the conversation loading, Chats paging and
folder responsiveness fixes and the latest phone/tablet regression checks.

# Falcon Native pilot

A standalone iPhone/iPad SwiftUI client for FalconDeck. This is a small local
prototype, with its own bundle ID, Xcode project, dependency graph, and Keychain
namespace. It does not change the Expo app, daemon, shared protocol, or releases.

## Try it locally

Requires Xcode with an iOS 26+ simulator runtime and XcodeGen (`brew install xcodegen`).
From this directory:

```sh
./scripts/run.sh           # restore a paired computer, or show welcome
./scripts/run.sh --demo    # clearly labelled sample data
```

Select **FalconDeck Native Pilot** in Device Hub (Simulator on older Xcode). The script creates/reuses a
dedicated simulator and leaves other simulators alone. Set `SIMULATOR_UDID` to
use another device. Alternatively, open `FalconDeckNative.xcodeproj` and run the
`FalconDeckNative` scheme. Regenerate the project with `xcodegen generate` after
adding source files or changing `project.yml`.
The build generates the app icon locally from the checked-in Falcon vector mark.

Keep Xcode's local simulator signing enabled: building with
`CODE_SIGNING_ALLOWED=NO` prevents Keychain access. Simulator builds use local
ad-hoc signing and do not need distribution credentials. No TestFlight, EAS,
deployment, or production build steps are included.

## Connect real projects

1. In the desktop app, create a remote pairing link under remote access settings.
2. Open **Connection** in Falcon Native and paste the **complete secure link**.
3. Tap **Connect securely**. A custom relay in the link is honored; the default
   is `https://connect.falcondeck.com`.

This registers an additional device named **Falcon Native Pilot**. It does not
reuse the Expo app's identity. Credentials and the session data key live in this
client's Keychain; project lists and conversations stay in memory. A normal
relaunch restores the connection. **Forget this connection** deletes the local
credentials; revoke the trusted device from desktop settings if no longer needed.

The pilot owns only `falcondeck-native://pair?code=…` deep links so it cannot
intercept the released app's links. Ordinary HTTPS pairing links can be pasted.
Pairing credentials should never be added to source control or screenshots.

## Included

- Searchable real project list, with working-agent and task counts.
- Project tasks, pins, search, and All / Working / Needs you filters.
- Cross-project activity and the latest conversation page (50 items).
- Native navigation, project zoom transitions, glass toolbars/tab bar/sheets,
  spring entrance motion, haptics, SF Symbols, selectable text, and share menus.
- Dynamic Type, Reduce Motion support, and the existing Falcon dark palette/mark.
- Signed secure pairing, pinned daemon identity, NaCl session-key unwrap,
  CryptoKit AES-GCM, WebSocket tickets, and bounded chunk reassembly.

CryptoKit handles signing and content encryption. [Swift-Sodium](https://github.com/jedisct1/swift-sodium)
0.11.0 handles the NaCl box format already used by the relay. No JavaScript,
React Native bridge, webview, or wrapper UI is involved.

## Deliberately small

This client is **read-only**. It calls only `snapshot.current` and `thread.detail`.
It cannot send prompts, start agents, approve requests, edit projects, or deploy.
Activity status helps you see what needs attention; handle those requests in the
existing clients.

It requests an authoritative snapshot on connection, on pull-to-refresh, and
every 10 seconds while running. It does not implement the production live-event
reducer or persist a relay cursor. Pruned replay is therefore not a local source
of truth. Background/foreground reconnect and explicit reconnect are included;
automatic network retry with backoff is a future step.

The conversation shows user/assistant messages with basic inline Markdown.
Tool cards, attachments, older-history pagination, rich code blocks, streaming,
notifications, QR scanning, light theme, and task creation are omitted. The
demo conversation is fixed sample content; live mode shows actual task history.

## Verification

```sh
xcodebuild -project FalconDeckNative.xcodeproj -scheme FalconDeckNative \
  -destination 'platform=iOS Simulator,name=FalconDeck Native Pilot' \
  -derivedDataPath build test
```

Five focused tests cover TypeScript AES interoperability and tamper rejection,
secure pairing parsing/URL policy, signed authority verification, pinned signed
NaCl bootstrap verification, and ordered transport reassembly/type-first ACKs.

Local simulator checks also exercise real hosted-relay pairing, project/task
reads, conversation reads, and Keychain restoration after relaunch. Screenshots
and build products are local ignored artifacts, not release assets.

# Falcon Native pilot

A standalone iPhone/iPad SwiftUI client for FalconDeck. This is a local
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

- Adaptive native sidebar: global pins, projects, project pins, synced folders,
  task search, paging, and the daemon's project ordering/visibility preferences.
- Create tasks with an agent/model selection; rename, pin, move, and archive.
- Create, rename, collapse, and delete folders using atomic daemon mutations.
- Send messages and queued follow-ups, choose model/reasoning effort, stop turns,
  and receive encrypted live replies without waiting for sidebar refreshes.
- Native Markdown: headings, nested lists, links, quotes, tables, selectable text,
  highlighted code blocks with copying, and horizontal code/table scrolling.
- Collapsible reasoning, tools, plans, changes, and earlier-history pagination.
- Exact provider approval choices, plan review, and question/secret-answer forms.
- Glass composer/toolbars/sheets, keyboard avoidance, jump-to-latest behavior,
  haptics, SF Symbols, and share menus. iPad keeps sidebar and chat side by side.
- Dynamic Type, Reduce Motion support, and the existing Falcon dark palette/mark.
- Signed secure pairing, pinned daemon identity, NaCl session-key unwrap,
  CryptoKit AES-GCM, WebSocket tickets, and bounded chunk reassembly.

CryptoKit handles signing and content encryption. [Swift-Sodium](https://github.com/jedisct1/swift-sodium)
0.11.0 handles the NaCl box format already used by the relay. No JavaScript,
React Native bridge, webview, or wrapper UI is involved.
The Markdown renderer uses [MarkdownUI](https://github.com/gonzalezreal/swift-markdown-ui)
2.4.1 with Falcon's native colors and code presentation.

## Deliberately small

This remains a prototype, with the core task/chat flow implemented against the
existing daemon RPCs. Sending messages and handling requests are real actions on
the paired computer. Permission settings are inherited from the task; choosing a
model does not silently change them. Failed/uncertain sends are never retried
automatically. A message sent while a task is busy is queued by the daemon.

It requests an authoritative snapshot on connection, on pull-to-refresh, and
every 10 seconds while running. Live events update the selected transcript
immediately and sidebar metadata in bounded batches. UTF-16 offsets suppress
duplicate text and detect gaps, which trigger authoritative history recovery.
History requests replay events that arrive while a page loads. No relay cursor
is persisted; pruned replay is never treated as a local source of truth.
Background/foreground reconnect and explicit reconnect are included;
automatic network retry with backoff is a future step.

Attachments/image rendering, notifications, QR scanning, light theme, queue
editing, git/diff panels, and extensions/settings parity are still omitted.
Markdown images display a placeholder rather than silently fetching external
content. Tool-output previews are bounded. Syntax coloring is lightweight rather
than a language-server parser. Demo chat produces a fixed labelled local reply;
live mode uses the actual agent. No release or deployment steps are included.

## Verification

```sh
xcodebuild -project FalconDeckNative.xcodeproj -scheme FalconDeckNative \
  -destination 'platform=iOS Simulator,name=FalconDeck Native Pilot' \
  -derivedDataPath build test
```

Eleven focused tests cover TypeScript AES interoperability and tamper rejection,
secure pairing parsing/URL policy, signed authority verification, pinned signed
NaCl bootstrap verification, ordered transport reassembly/type-first ACKs,
UTF-16 streaming/overlap/gap handling, optimistic echo reconciliation, paged
history merging, content targets, permission-preserving requests, and exact
approval scopes.

Local simulator checks also exercise real hosted-relay pairing, project/task
reads, task creation, real chat round trips, rendered Markdown, and Keychain
restoration after relaunch. Screenshots
and build products are local ignored artifacts, not release assets.

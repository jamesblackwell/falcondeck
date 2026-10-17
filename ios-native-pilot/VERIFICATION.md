# Native client handoff — 17 October 2026

Falcon Native is installed over Wi-Fi on the paired iPhone under its separate
`com.falcondeck.pilot.native` bundle ID. The latest Apple Development Debug build
includes the WidgetKit speech extension. Deep signature verification passes.
The released FalconDeck app remains installed separately. No production build,
relay deployment, OTA, Expo build or TestFlight submission was performed.

The phone is locked, so `devicectl` launch is refused by iOS. Unlock and open
**Falcon Native**. Pair this separate client through **Connections**, using a
new desktop Remote Access QR code or signed pairing link. The iPad also needs
unlocking before Xcode can mount its development image and install. Use
`scripts/install-device.sh <paired-device-identifier>` when it is reachable.
No device identifiers or pairing credentials are checked in.

## Validation

- 85 unit tests pass on the iPhone simulator (`FalconDeckNative` scheme).
- Both `FalconDeckNativeUI` tests pass on iPhone and iPad simulators: automation
  creation/save and first-send task creation with native Markdown rendering.
- An additional iPad run asserts that the app actually has landscape dimensions
  before opening and saving the automation. It passes. Screenshots are retained
  in the local Xcode test results; full-screen capture avoids rotated-window
  cropping in `XCUIApplication.screenshot()`.
- Real relay pairing, encrypted connection, compact project sync and a live
  native conversation were exercised. Demo UI tests send only local sample
  messages and create only in-memory automations.
- The signed arm64 app/widget build succeeds; `codesign --verify --deep --strict`
  succeeds; the final build installs on the physical iPhone over Wi-Fi.

The UI checks exposed two real bugs. Dynamic UIColor resolution on a background
UIKit queue triggered a main-actor dispatch assertion; a failing regression now
passes after making the provider nonisolated/Sendable. The composer's blank
input area did not reliably focus; a minimum 44-point hit region and explicit
focus gesture make the same keyboard/type/send regression pass.

## Review

Significant implementation commits were reviewed with the repo-local helper:

```sh
.agents/skills/autoreview/scripts/autoreview \
  --mode commit --commit <sha> --max-priority P2 \
  --dataset ios-native-pilot/FalconDeckNative/Data/Wire.swift
```

Reviews used disposable detached checkouts so unrelated concurrent work was
excluded. Accepted findings were verified, fixed and covered by focused checks:
unloaded transcript exports, media/recording interruption and request races,
notification terminal-state handling, stale extension replacements/read counters,
and realtime Stop being undone by subsequent chunks. Later reviews of recovery
(`03480863`), task actions (`4af99bb2`), callback/audio fixes (`4b829810`) and speech
recovery (`26ab6a9f`) reported no actionable P0–P2 findings.

The final review of `288b565f` reported one P2 assertion that a vertical SwiftUI
TextField must expose an XCTest TextView. This was rejected against runtime
evidence: both simulators expose `chat-input` as a TextField, and the exact query
finds, focuses, types and sends successfully in the passing UI runs. No other
actionable findings were reported. The subsequent screenshot/landscape assertion
and documentation changes are test-only verification and handoff updates.

## Remaining limits

Background remote push requires a native APNs relay path. The current relay
delivers Expo push only; it was deliberately left unchanged. This blocker was
sent through NTFY. Connected opt-in local alerts are implemented.

Physical camera, microphone, speech language availability, Live Activity buttons
and Lock Screen behavior await unlocked-device testing. Simulator success does
not establish hardware behavior. Common Mermaid flowcharts render natively;
other Mermaid syntax remains complete copyable source. Unsupported desktop
extension frontends retain an explicit desktop fallback. Search clearly covers
loaded tasks and offers loading more.

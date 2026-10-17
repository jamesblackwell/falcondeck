# Native client verification — 17 October 2026

Falcon Native uses the separate `com.falcondeck.pilot.native` application ID and
Apple Development signing. The latest Debug app and speech widget are installed
and launched over Wi-Fi on the paired iPhone. Open **Falcon Native** to test
the updated pairing flow. The physical iPad needs unlocking before its
development image can mount and installation can proceed. No device inventory or credentials are
checked in.

The opening screen now follows Expo: **Scan QR code**, or enter the full secure
code/link and **Connect**. Scanning or opening a native pairing link connects
automatically. A custom relay gets one explicit server review. Setup remains
visible until the first encrypted workspace snapshot arrives. Connection
metadata, reconnect and forgetting a computer live in **Settings → Connections**.

## Client validation

- 102 native unit tests pass, including crypto/wire compatibility, pairing
  authority, connection epochs, drafts/queues, media, controls/extensions,
  push registration/cleanup and seven new pairing-flow regressions.
- Three iPhone UI tests pass: first-send/Markdown, landscape automation saving,
  and the scan-or-enter pairing layout with inline validation and cancellation.
- The same three UI tests pass on iPad, including the explicit landscape
  dimension assertion before opening and saving an automation.
- Real relay pairing, encryption, compact project sync and a native conversation
  were exercised. The upgraded relay reconnects successfully with end-to-end
  encryption. Demo UI tests send only in-memory messages/automations.
- Apple Development arm64 app/widget builds succeed. Build products, Xcode
  results and screenshots remain local and ignored.

## Relay and native push

Optional APNs support is live alongside the existing Expo provider. The relay
advertises only configured topics/environments; this Debug app uses sandbox.
The provider-tagged registration and foreground-activity contracts are documented
in [push-client-protocol.md](../docs/push-client-protocol.md).

Verification covered mixed providers, authorization and payload validation,
provider failure/retry isolation, stale-token cleanup, concurrent registration
replacement, PostgreSQL persistence/restarts and the exact previously deployed
schema upgrade. Isolated PostgreSQL tests never used production credentials.
The existing Expo notification/routing regressions (58 tests) and client-core
typecheck pass. Scoped Rust checks pass; strict Clippy uses an allowance only
for the pre-existing core `enum_variant_names` warning.

The rollout built a pinned relay candidate separately, backed up the old binary,
environment and database, then changed only the relay binary and optional APNs
configuration. Health and capabilities pass. Read-only post-upgrade assertions
confirmed all prior active trusted-device credential verifiers and Expo tokens
were preserved, devices remained present, replay sequences stayed monotonic,
and daemon heartbeats continued. No released app build, Expo OTA, TestFlight,
website or desktop/daemon deployment occurred.

Real Apple sandbox HTTP/2 authentication passes. The native simulator obtained
an APNs token and displayed “Background notifications are registered with your
relay.” A delivered background banner on physical hardware remains unverified.

## Review

Significant changes use the repository-local helper in commit mode with explicit
SHAs and `--max-priority P2`, keeping unrelated concurrent changes out of scope:

```sh
.agents/skills/autoreview/scripts/autoreview \
  --mode commit --commit <sha> --max-priority P2 \
  --dataset <adjacent-contract-source>
```

The initial push review (`485121a8`) found cold-launch cleanup and lost-response
registration bugs. They were verified and fixed in `33b1fd57`, whose review then
found legacy-relay cleanup handling. That fix (`b768b6de`) and the old-schema
migration regression (`664cbd3a`) both reviewed clean with no actionable P0–P2
findings. The initial pairing-flow review (`99f824cd`) found that incoming
links could be dropped during reconnect; the real recovery path now has a
passing regression and the fix is in `57c50df5`. That fix reviewed clean with
no actionable P0–P2 findings.

Earlier native reviews verified and fixed transcript export, media interruption,
stale response/extension handling and realtime Stop races. The composer focus
and background theme callback crashes have passing UI/regression coverage.

## Remaining hardware limits

Camera scanning, microphone/speech languages, Live Activity controls and Lock
Screen behavior still need physical-device testing. Common Mermaid flowcharts
render natively; other syntax remains complete copyable source. Unsupported
desktop extension frontends have an explicit desktop fallback. Search clearly
covers loaded tasks and offers loading more. This is an implemented parity
client ready for testing, not a claim that every hardware interaction has passed.

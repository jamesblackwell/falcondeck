# Native client verification — 17 October 2026

Visual polish follow-up: see [VISUAL-QA.md](VISUAL-QA.md) for the expanded
screen/state checks, screenshot gallery and current device status.

Falcon Native uses the separate `com.falcondeck.pilot.native` application ID and
Apple Development signing. The latest harness/composer/cache Debug app and
speech widget were installed over Wi-Fi on the paired iPhone on 18 October.
iOS refused automatic launch because the phone was locked; open Falcon Native
after unlocking. No device inventory or credentials are checked in.

The opening screen now follows Expo: **Scan QR code**, or enter the full secure
code/link and **Connect**. Scanning or opening a native pairing link connects
automatically. A custom relay gets one explicit server review. Setup remains
visible until the first encrypted workspace snapshot arrives. Connection
metadata, reconnect and forgetting a computer live in **Settings → Connections**.

## Client validation

- 215 native unit tests pass, including crypto/wire compatibility, pairing
  authority, connection epochs, drafts/queues, media, controls/extensions,
  push registration/cleanup the whole-source review regressions and harness composer/cache recovery.
- All 39 UI checks pass on iPad. On iPhone, 38 passed in the complete run;
  one goal check was interrupted by an accidental overlapping unit run and
  passed when rerun alone. The final changed build also passes first send and
  both streaming/reading-position checks on both sizes. Coverage includes
  navigation/density, requests, goals, settings, voice states, search, pairing,
  keyboard behavior, archive recovery and landscape automation.
- Additional compact-width, accessibility-text and landscape conversation checks
  pass. See [VISUAL-QA.md](VISUAL-QA.md) for the current screen/state inventory.
- The new voice flow passes focused phone/iPad composer, first-send and keyboard
  checks, plus all four voice states at accessibility text sizes. Transcription
  request/model parity, retries, cancellation, Unicode insertion and Lock Screen
  Finish selection are covered by isolated tests. See [VOICE-QA.md](VOICE-QA.md).
- Real relay pairing, encryption, compact project sync and a native conversation
  were exercised. The upgraded relay reconnects successfully with end-to-end
  encryption. Demo UI tests send only in-memory messages/automations.
- Apple Development arm64 app/widget builds succeed. Build products, Xcode
  results and screenshots remain local and ignored.

## Harness composer parity — 18 October

Compared the native composer with Expo's model selection, catalog cache,
provider hydration, provider switching, reasoning and service-tier contracts.
Codex, Claude and OpenCode use the same normalized daemon fields; OpenCode
native variants and ACP reasoning options are already normalized server-side.

Changes include encrypted last-known model catalogs, live-first replacement,
provider-specific saved choices for new tasks/folders, searchable large model
lists with accessible reasoning controls, Claude version/context labels, correct
workspace defaults and isolated
capabilities. Existing task settings follow authoritative daemon updates while
preserving unsubmitted local picks. Fast empty hydration results no longer
wait for the full timeout just because polling missed the loading transition.

Caching is display metadata only: 32 workspace/provider entries, 1,000 models
and 256 KiB per catalog, 1 MiB total, inside the existing pairing-encrypted
preview. Empty lazy snapshots retain useful catalogs; nonempty live metadata
replaces them. Old previews still decode. Permission and sandbox choices never
come from the model cache. Composer preferences avoid identical disk writes.

Validation uses local fixtures shaped from each daemon transport's metadata,
including OpenCode slash IDs, variants, plain models and its synthetic default.
It does not start paid/live agent turns or change harness installations.

All 215 native unit tests pass. The 14 loading/harness UI scenarios pass across
phone and tablet, including focused reruns after layout changes; screenshots
were inspected for both sizes. Expo/shared reference checks pass (65 tests).
Apple Development app/widget builds succeed with the existing standalone ID.

Repo-local Autoreview (`--mode local --max-priority P2`) reported no actionable
findings for the harness/cache changes and subsequent settings/cache fixes.
The final restore fallback and search layout changes also reviewed clean.
The final picker/search layouts were verified with phone/iPad UI tests.

## Model and reasoning picker — 18 October

The native composer now requests lazy provider metadata on new tasks and when
an existing task has no model catalog, matching Expo's `provider.hydrate` flow.
The RPC acknowledges scheduling; workspace events deliver the actual models.
The picker observes live project metadata and shows loading/retry states while
waiting. Requests are shared per project/provider and connection, have a
bounded wait, and can restart if a previously populated live catalog empties.
Late metadata clears obsolete loading errors.

Legacy workspace catalogs remain usable when an agent omits its model field.
Reasoning falls back to an advertised default effort when no supported-effort
list is supplied. Versioned Claude models inherit the alias's reasoning
metadata while retaining their recorded model/version. Explicitly clearing a
model selection displays the provider default's reasoning choices. Selected
model and effort values are verified in both first-turn and existing-task RPCs.

Two metadata regressions and the empty existing-task picker failed before the
fix. All 199 unit tests pass. Three focused UI flows pass on both iPhone and
iPad: new task, existing task with retained reasoning selection, and retry after
hydration fails. Screenshots were inspected, including loading and tablet
scrolling. Fixtures use local content and never start real agent turns.

Repo-local Autoreview uses `--mode local --max-priority P2` with the native-only
patch and adjacent provider, model-selection and request contracts. Its initial
findings about metadata invalidation and clearing a model selection were
verified and fixed. The final rerun reported no actionable P0–P2 findings.
The signed development build remains a separate native
app; Expo, the daemon, relay, OTA and TestFlight are unchanged by this fix.

## Whole Swift source review

All 116 Swift files were read: 88 app, widget and utility files, 23 unit-test
files and five UI-test files. This covered every native screen and the state,
transport, persistence, media and speech code behind those screens.

The review fixed independently reproducible bugs in:

- Input recovery: one corrupt encrypted draft no longer hides healthy drafts;
  archiving and restoring a task retains unsent text and attachments.
- History: loading older messages does not apply live deltas twice; handoffs
  refresh stale history and stop safely when that refresh fails; Task options
  exposes history errors and allows retry before sharing.
- State races: late archive lists and automation refreshes retain newer
  changes; all preference controls, including folders, share one serialized
  writer, newer preference events win over old responses, and superseded
  automation run-history responses are ignored.
- Media: shared reads reject results from previous connections, active tool
  output is fetched again, and updates invalidate in-flight cache writes.
- Notifications: local alerts carry the same computer/workspace routing as
  remote notifications and cannot open a task belonging to a prior pairing.
  Cached preferences cannot change remote push registration before live state
  arrives.
- Connections and first send: a saved claim retries after a ticket failure;
  asynchronous handshake errors also retry after pairing finishes. First-send
  input is captured independently of newer composer edits, recovered when
  offline guards reject it, and folder placement preserves newer navigation.
- Scrolling: history anchors become invalid after a newer reading gesture,
  so a late history response cannot pull the reader back.
- Transport: acknowledged upload time is separate from the RPC response
  deadline. Individual writes, chunk acknowledgements and cancellation writes
  have deadlines, including a WebSocket stalled before its handshake.

Unit-test hosts and fake-relay fixtures now use isolated recording/preferences
state and never restore the development app's saved relay credentials. Three
new state regressions were confirmed failing before their fixes; the earlier
review batches likewise reproduced the draft/history/media/state failures.

The final 188-test unit suite and signed arm64 app/widget build pass. All 39
UI checks are green across the complete runs and the isolated iPhone rerun.
UI fixtures use local content; no real agent turns or automations were
started by them. Screenshots and Xcode result bundles remain ignored/local.

Repo-local Autoreview was run in a native-only review worktree with the command
below. The complete runtime sources were supplied in two bounded datasets
(state/media and views/design/widget), with adjacent contracts included.
Unchanged files remained in the requested review scope. Findings were checked
against their actual call paths and received focused regressions. Reruns used
the complete changed ownership boundaries and the native-only patch. The final
pass completed clean with no actionable P0–P2 findings.

```sh
.agents/skills/autoreview/scripts/autoreview \
  --mode local --max-priority P2 \
  --dataset <each-complete-source-file-in-the-batch> \
  --prompt <whole-source-review-scope>
```

This pass changes only the standalone native client and its tests/documentation.
It makes no relay, daemon, Expo, OTA, TestFlight or production changes.

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

# Native mobile parity

Scope: mirror `apps/mobile/src/app` and its composer/sidebar actions in a separate
SwiftUI client. Released mobile builds, the daemon, Expo OTA and TestFlight are
outside this work. Optional APNs support was added and deployed to the relay
alongside the unchanged Expo route. The daemon and agent storage remain authoritative.

| Area | Existing mobile behavior to mirror | Native status |
| --- | --- | --- |
| Connection | Secure link/QR pairing, saved Keychain identity, presence, reconnect, diagnostics | Expo scan-or-enter layout; scans/links connect automatically and wait for an encrypted snapshot; self-hosted relay review, Keychain, reconnect/backoff and diagnostics; physical QR QA awaits device |
| Navigation | Sidebar, chats, projects, global/project pins, folders, search/sort/hidden/archive | Sidebar, pins, folders, lazy pages, per-device sort, hidden projects, project order and icon choices implemented; search states its loaded scope and can fetch more |
| New task | Draft composer, provider/model selection, first-send creation, folder filing | Implemented; first-send and failed-send regression tests pass |
| Composer | Model, effort, permissions, sandbox, collaboration, speed, skills/prompts | Capability-based models/modes/permissions/sandbox/speed plus provider-scoped skills and saved prompt shortcuts |
| Turns | Live replies, queue/edit/remove/steer, interrupt, resume interrupted, compact | Send/interrupt, queues, shutdown-resume, edit/retry branching and cross-agent handoff implemented |
| Plan reviews | Approve implementation, request revisions with feedback, abandon the plan | Native actions use the existing `approved`, `cancelled` with trimmed multiline feedback, and `abandoned` responses; failed submissions retain feedback and the pending review |
| Task actions | Rename/suggest, read/unread, archive/unarchive, branch/retry, handoff | Rename/suggest/read/unread/pin/archive/read-archived/restore, branch/retry and cross-agent handoff implemented; read/unread is available from task options, long-press menus and a leading swipe |
| Goals | Set objective/budget, status/usage, pause/resume/stop | Implemented; local lifecycle/budget test passes |
| Transcript | Markdown/code/tables, reasoning/tools/groups, plans/diffs/files, images, search/artifacts/reviews/unknown fallback | All wire item kinds have a native renderer or inspectable fallback; grouping, preferences, harness projection, citations, native Mermaid flowcharts and complete-source fallback implemented |
| Media | Library/camera/clipboard attachments, image preview/save/share, read aloud, recording/transcription | Native attachments, read aloud, on-device/computer transcription, speech Live Activity/Lock Screen controls and bounded realtime PCM implemented; physical media QA awaits device |
| Activity | Running/attention/all tasks, navigation | Matches Needs input / Failed / Ready to review / Running / Recent sections; archived tasks remain separate |
| Automations | List/create/edit/enable/delete/run/history/settings via control RPC | Implemented and tested (control revision/idempotency/validation); iPad landscape create/save UI check passes |
| Settings | Appearance palettes/text, conversation preferences, notifications, speech, connection, about/developer | Implemented: all 19 palettes, text size, conversation, native APNs/connected alerts, speech, connections and diagnostics |
| Extensions | Tags/stage markers, sidebar filters/panel fallbacks, composer suggestions | Stages, filters, suggestions and declarative native panels implemented; unavailable panels use the mobile desktop fallback |
| Device support | iPhone/iPad, portrait/landscape/multitasking, keyboard, Dynamic Type, Reduce Motion | Phone navigation/theme changes and iPad split-view/settings/automation creation verified; first-send keyboard and Markdown UI regression passes |
| Installation | Separate app ID, development-signed device build, Wi-Fi install command | Apple Development app/widget build and signature verification pass; installed and launched over Wi-Fi on iPhone; physical iPad install requires unlocking |

Implementation is ready for device testing. Hardware behavior and the platform
constraints below remain explicit gaps; this is not a claim of exhaustive parity.

## Core functionality check — 22 October 2026

Mark read/unread now has a shared action in task options, sidebar and Activity
context menus, plus a leading sidebar swipe. Explicit unread survives while the
conversation stays open; deliberately reopening it acknowledges the visible
activity again, including tapping the same selection on iPad. Failed unread
requests release auto-read suppression. Successful replies bind suppression to
the daemon's returned activity sequence, while a late reply cannot reinstate
suppression after navigation. Tasks without agent activity cannot be made unread
under the existing daemon contract; the action is disabled for those tasks and
while disconnected. Native tests reproduce the three prior read-state failures. All 338 native unit
tests pass, and both read/unread UI checks pass on iPhone and iPad.
`.agents/skills/autoreview/scripts/autoreview --mode local` is clean with native
read-state source supplied as review context.

Plan review now includes requested-change feedback and Abandon plan alongside
Approve and implement. Blank feedback cannot be submitted as a revision request,
and a missing plan cannot be approved. Submission leaves the separate composer
draft untouched; failed responses keep the feedback and review available for
retry. Actions are disabled while sending or disconnected. All 346 unit tests
and the five plan-review UI checks on both iPhone and iPad pass; repo-local
Autoreview is clean.

The comparison with the existing mobile client found two gaps, both since closed:

| Gap | Resolution (22 October 2026) |
| --- | --- |
| Navigation between spawned tasks | `SpawnNesting` ports client-core's `nestSpawnedThreads`: agent-spawned tasks follow their parent in project, folder and chat lists, a family keeps its best-placed member's rank, orphans and cycles stay visible, and depth caps at three. |
| Production native push | The hosted relay now advertises `com.falcondeck.pilot.native` for both `sandbox` and `production`, reusing the existing signing key. The prior config is kept beside it as a timestamped backup. Delivery to a production token is unverified until a TestFlight build registers one. |

This was a focused code and contract comparison around task navigation, read
state and agent control, not an exhaustive device QA pass. The first native
TestFlight app record and upload remain pending from the release preparation;
the signed TestFlight candidate includes the unread fixes and needs another
rebuild to include the plan-review actions.

## Visual and performance pass — 22 October 2026

The native Mac client is the visual baseline. Changes:

- Theme tokens resolve to one cached `Color` per palette pair. A fresh dynamic
  `UIColor` per read never compared equal, so every themed view counted as
  changed on each render. The activity diamond pulses in Core Animation rather
  than a repeating symbol effect. With running tasks on screen, idle app CPU in
  the simulator fell from about 3% to about 0% (CPU-time delta over 20 s).
- MarkdownUI is replaced by the Mac client's block parser with Dynamic Type
  fonts: tighter lists, Grid tables, Mac-style code blocks and diff colouring.
- Transcript rows use one full-width disclosure with a leading chevron. Thoughts
  read "Thinking · 0:12" live and "Thought for 12s" (or the time) when settled,
  and expand only when there is text beyond the label. Tools show duration, exit
  code, test results and failure tint. Plans show progress and in-progress steps.
  Read-aloud and voice state are observed only by the reply's own controls.
- Plan reviews are a compact card with Review plan and Approve; the full plan,
  feedback and all three outcomes live in a review sheet. Approvals and
  questions share the card. Requests get more tray height than notices.
- App-wide errors appear in one auto-dismissing banner instead of inside every
  conversation; system orange is replaced by palette warning/danger/success.
- Activity has section icons, relative times, previews and project/provider.
  Sidebar rows show relative times and have Archive/Pin trailing swipes.
- New tasks show a project prompt and a single-line Work-in pill. Projects
  without an icon get a stable monogram. Appearance shows palette swatches.
  Images zoom with a native scroll view (pinch anchoring, double-tap).

## Earlier implementation milestones

Core parity milestone: 28 iPhone simulator unit tests pass. A development-signed
arm64 build succeeds for the separate native bundle ID. UI parity QA continues.

Earlier platform constraint (resolved by the APNs milestone below): relay push delivery in `crates/falcondeck-relay/src/app.rs`
is Expo-only (`EXPO_PUSH_URL`). A Swift-only development client cannot receive
background remote notifications through that route. Native APNs delivery needs
a separate relay implementation/deployment; production remains untouched. James
was notified via NTFY, and all other parity work continues.

Media milestone: 35 tests pass. iPad Pro 11-inch simulator boots with sidebar
and detail visible. Core review finding (sharing an unopened task exported an
empty transcript) is fixed by loading history and disabling sharing until ready;
partial exports are explicitly labelled and include tool/file/plan output.

Recovery milestone: 57 simulator tests pass. Encrypted device input drafts and uncertain-send recovery survive restarts; compact sync carries visible rows and rejects pages raced by live archive events. Notification review findings are fixed: completion alerts require terminal states and unsupported desktop-activity suppression is not offered for connected native alerts. Phone appearance changes verified visually.

Task-action milestone: 63 tests pass. Fake-relay checks verify edit/retry fork boundaries, permission preservation, interrupted resume inputs, skill matching, Unicode context limits, and handoff that never starts a turn or mutates the source. QR scanning uses VisionKit and preserves the signed-pairing validation path; simulator fallback is explicit.

Navigation/extensions milestone: 70 tests pass. Live extension updates and tombstones win over delayed snapshot loads, filter definitions survive ordinary data projections, suggestions preserve draft text/images, and background commands remain in Running. Project icons use the encrypted daemon RPC with bounded native thumbnails. Read-aloud now registers native Lock Screen/headset play/pause/stop controls only while active. Core compact-sync and task-action review passes are clean through P2.

Rich-media milestone: 81 tests pass. Separate WidgetKit extension builds with native ActivityKit speech controls. Realtime PCM validates channel/rate/frame bounds, caps playback memory and active sessions, and preserves signed samples. Common Mermaid flowcharts render with native shapes; unsupported Mermaid syntax remains fully visible and copyable as source. Extension review findings (stale views after replacement and demo read counters) are fixed with regressions. Physical camera/microphone/Lock Screen behavior still needs device verification.

QA fix milestone: 83 tests pass. A failing background color-resolution test reproduced the iPad editor-dismissal crash; the theme provider is now nonisolated and explicitly Sendable. Background network/audio/media-command callbacks declare their concurrency boundary. The same iPad automation creation/save flow now completes and remains visible. Realtime Stop suppresses further chunks until stream end/new start. Both app and WidgetKit extension development signing succeeded; rebuild the final binary after all QA fixes.

Speech recovery milestone: 85 tests pass. Failed new-chat creation preserves the recording and existing draft; successful recovery appends without overwriting input. Pending recovery actions are disabled while creating the chat. Transcription callbacks explicitly cross onto the main actor, and connection changes cancel recognition while retaining audio. Phone/tablet orientations and iPad resizing are declared explicitly. README now documents the actual native feature set and remaining hardware/push limits.

Earlier UI regression: the original composer failed to focus when its blank input area was tapped. A 44-point content shape now focuses the complete field; the same keyboard/type/first-send/Markdown test passes. The signed Debug app is installed alongside the released app on the iPhone. The device is locked, so launch and physical media testing await unlock. The physical iPad also requires unlock before Xcode can mount its development image and install. No production deployment occurred.

## Current relay and connection milestones

Native push milestone: optional APNs is live alongside Expo, with provider-tagged registration, capability discovery, foreground activity negotiation, generation-safe persistence and token cleanup. Existing active trusted credentials and Expo tokens survived the relay upgrade unchanged. Real Apple sandbox authentication and native simulator registration pass. A physical-device background banner remains unverified. No released app build or OTA was pushed.

Connection UX milestone: 102 unit tests pass, including seven new scan/link, duplicate-consumption, startup, relay-review and retry regressions. Pairing follows Expo’s scan-or-enter layout, automatically claims valid scans/links, and waits for the encrypted workspace before dismissing setup. Diagnostics and Forget live in Settings → Connections.

## Bot marks and bot sheet — 1 November 2026

Bots now carry their web mark everywhere they appear. `BotMark` ports
`packages/chat-ui/src/components/bot-mark.tsx` shape for shape (circle, diamond,
square, triangle, hexagon, star, pentagon, cross in the same 16×16 box, 1.2 pt
rounded stroke) and maps `cat-1`…`cat-12` onto the active palette's categorical
colors. Bots saved before icons existed get the daemon's next unused shape and
color, resolved exactly like `resolveBotIcons`.

| Surface | Behaviour |
| --- | --- |
| Sidebar bots | Mark in place of the generic glyph; a bot needing you shows the warning dot and "Needs you", working shows the activity diamond |
| Conversation header | Bot title shows its mark and a chevron; tapping opens the bot sheet |
| Bot sheet | STATUS.md with its age (warning tint after 24 h), owned open tickets, schedules with an enable switch, and work dispatched in the last two days; "Show all" past eight rows; Bot settings opens the editor |
| Activity and sidebar rows | Bot home tasks show the mark; dispatched work names its bot |
| Replies and STATUS.md | Links to a bot's conversation carry its mark inline |

The sheet reads existing daemon data only (`bots.documents`, `control.get` for
`tickets` and `automations`, `control.execute` pause/resume); no protocol change.
Schedules match on the bot's home task, including earlier home tasks after a
harness switch. `--demo --bots-preview` seeds three bots (one without a stored
mark), STATUS.md, tickets, schedules and dispatches for QA.


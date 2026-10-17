# Native mobile parity

Scope: mirror `apps/mobile/src/app` and its composer/sidebar actions in a separate
SwiftUI client. Production mobile, daemon, relay, Expo, OTA, and TestFlight are
outside this work. The daemon and agent storage remain authoritative.

| Area | Existing mobile behavior to mirror | Native status |
| --- | --- | --- |
| Connection | Secure link/QR pairing, saved Keychain identity, presence, reconnect, diagnostics | Link pairing, saved identity, automatic reconnect/backoff, compact sync and diagnostics and native QR scanner present; physical QR QA awaits device |
| Navigation | Sidebar, chats, projects, global/project pins, folders, search/sort/hidden/archive | Sidebar, pins, folders, lazy pages, per-device sort, hidden projects, project order and icon choices implemented; search states its loaded scope and can fetch more |
| New task | Draft composer, provider/model selection, first-send creation, folder filing | Implemented; first-send and failed-send regression tests pass |
| Composer | Model, effort, permissions, sandbox, collaboration, speed, skills/prompts | Capability-based models/modes/permissions/sandbox/speed plus provider-scoped skills and saved prompt shortcuts |
| Turns | Live replies, queue/edit/remove/steer, interrupt, resume interrupted, compact | Send/interrupt, queues, shutdown-resume, edit/retry branching and cross-agent handoff implemented |
| Task actions | Rename/suggest, read/unread, archive/unarchive, branch/retry, handoff | Rename/suggest/read/unread/pin/archive/read-archived/restore, branch/retry and cross-agent handoff implemented |
| Goals | Set objective/budget, status/usage, pause/resume/stop | Implemented; local lifecycle/budget test passes |
| Transcript | Markdown/code/tables, reasoning/tools/groups, plans/diffs/files, images, search/artifacts/reviews/unknown fallback | All wire item kinds have a native renderer or inspectable fallback; grouping, preferences, harness projection, citations, native Mermaid flowcharts and complete-source fallback implemented |
| Media | Library/camera/clipboard attachments, image preview/save/share, read aloud, recording/transcription | Native attachments, read aloud, on-device/computer transcription, speech Live Activity/Lock Screen controls and bounded realtime PCM implemented; physical media QA awaits device |
| Activity | Running/attention/all tasks, navigation | Matches Needs input / Failed / Ready to review / Running / Recent sections; archived tasks remain separate |
| Automations | List/create/edit/enable/delete/run/history/settings via control RPC | Implemented and tested (control revision/idempotency/validation); UI QA continuing |
| Settings | Appearance palettes/text, conversation preferences, notifications, speech, connection, about/developer | Implemented: all 19 palettes, text size, conversation, connected alerts, speech, connections and diagnostics |
| Extensions | Tags/stage markers, sidebar filters/panel fallbacks, composer suggestions | Stages, filters, suggestions and declarative native panels implemented; unavailable panels use the mobile desktop fallback |
| Device support | iPhone/iPad, portrait/landscape/multitasking, keyboard, Dynamic Type, Reduce Motion | Phone navigation/theme changes and iPad split-view/settings/automation creation verified; broader QA continues |
| Installation | Separate app ID, development-signed device build, Wi-Fi install command | Device build succeeds with existing Apple Development identity; phone currently offline |

This is a working checklist, not a claim of completed parity. Replace pending
entries with concrete implementation and verification as each area lands.

Core parity milestone: 28 iPhone simulator unit tests pass. A development-signed
arm64 build succeeds for the separate native bundle ID. UI parity QA continues.

Confirmed platform constraint: relay push delivery in `crates/falcondeck-relay/src/app.rs`
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

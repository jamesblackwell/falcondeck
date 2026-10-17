# Native mobile parity

Scope: mirror `apps/mobile/src/app` and its composer/sidebar actions in a separate
SwiftUI client. Production mobile, daemon, relay, Expo, OTA, and TestFlight are
outside this work. The daemon and agent storage remain authoritative.

| Area | Existing mobile behavior to mirror | Native status |
| --- | --- | --- |
| Connection | Secure link/QR pairing, saved Keychain identity, presence, reconnect, diagnostics | Link pairing, saved identity, automatic reconnect/backoff, compact sync and diagnostics present; QR pending |
| Navigation | Sidebar, chats, projects, global/project pins, folders, search/sort/hidden/archive | Sidebar, pins, folders and lazy pages present; project customization/search/sort pending |
| New task | Draft composer, provider/model selection, first-send creation, folder filing | Implemented; first-send and failed-send regression tests pass |
| Composer | Model, effort, permissions, sandbox, collaboration, speed, skills/prompts | Model/effort plus capability-based modes, permissions, sandbox and speed; skills/prompts pending |
| Turns | Live replies, queue/edit/remove/steer, interrupt, resume interrupted, compact | Send/interrupt and queue controls implemented; resume/branch/handoff pending |
| Task actions | Rename/suggest, read/unread, archive/unarchive, branch/retry, handoff | Rename/suggest/read/unread/pin/archive/restore implemented; branch/handoff pending |
| Goals | Set objective/budget, status/usage, pause/resume/stop | Implemented; local lifecycle/budget test passes |
| Transcript | Markdown/code/tables, reasoning/tools/groups, plans/diffs/files, images, search/artifacts/reviews/unknown fallback | All wire item kinds have a native renderer or inspectable fallback; grouping, shared conversation preferences and harness projection implemented; Mermaid remains |
| Media | Library/camera/clipboard attachments, image preview/save/share, read aloud, recording/transcription | Implemented; attachment/queue/export/Unicode tests pass; physical microphone testing awaits device |
| Activity | Running/attention/all tasks, navigation | Present; align filters and archive visibility |
| Automations | List/create/edit/enable/delete/run/history/settings via control RPC | Implemented and tested (control revision/idempotency/validation); UI QA continuing |
| Settings | Appearance palettes/text, conversation preferences, notifications, speech, connection, about/developer | Implemented: all 19 palettes, text size, conversation, connected alerts, speech, connections and diagnostics |
| Extensions | Tags/stage markers, sidebar filters/panel fallbacks, composer suggestions | Pending; match mobile contract, no arbitrary frontend execution |
| Device support | iPhone/iPad, portrait/landscape/multitasking, keyboard, Dynamic Type, Reduce Motion | Phone baseline checked; iPad QA pending |
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

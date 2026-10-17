# Native mobile parity

Scope: mirror `apps/mobile/src/app` and its composer/sidebar actions in a separate
SwiftUI client. Production mobile, daemon, relay, Expo, OTA, and TestFlight are
outside this work. The daemon and agent storage remain authoritative.

| Area | Existing mobile behavior to mirror | Native status |
| --- | --- | --- |
| Connection | Secure link/QR pairing, saved Keychain identity, presence, reconnect, diagnostics | Link pairing and saved identity present; expand recovery/QR/diagnostics |
| Navigation | Sidebar, chats, projects, global/project pins, folders, search/sort/hidden/archive | Core sidebar present; finish parity |
| New task | Draft composer, provider/model selection, first-send creation, folder filing | Implemented; first-send and failed-send regression tests pass |
| Composer | Model, effort, permissions, sandbox, collaboration, speed, skills/prompts | Model/effort plus capability-based modes, permissions, sandbox and speed; skills/prompts pending |
| Turns | Live replies, queue/edit/remove/steer, interrupt, resume interrupted, compact | Send/interrupt and queue controls implemented; resume/branch/handoff pending |
| Task actions | Rename/suggest, read/unread, archive/unarchive, branch/retry, handoff | Rename/suggest/read/unread/pin/archive/restore implemented; branch/handoff pending |
| Goals | Set objective/budget, status/usage, pause/resume/stop | Implemented; local lifecycle/budget test passes |
| Transcript | Markdown/code/tables, reasoning/tools/groups, plans/diffs/files, images, search/artifacts/reviews/unknown fallback | Text/Markdown/tool baseline present; expand all item kinds |
| Media | Library/camera/clipboard attachments, image preview/save/share, read aloud, recording/transcription | Pending |
| Activity | Running/attention/all tasks, navigation | Present; align filters and archive visibility |
| Automations | List/create/edit/enable/delete/run/history/settings via control RPC | Pending |
| Settings | Appearance palettes/text, conversation preferences, notifications, speech, connection, about/developer | Connection present; expand |
| Extensions | Tags/stage markers, sidebar filters/panel fallbacks, composer suggestions | Pending; match mobile contract, no arbitrary frontend execution |
| Device support | iPhone/iPad, portrait/landscape/multitasking, keyboard, Dynamic Type, Reduce Motion | Phone baseline checked; iPad QA pending |
| Installation | Separate app ID, development-signed device build, Wi-Fi install command | Device build succeeds with existing Apple Development identity; phone currently offline |

This is a working checklist, not a claim of completed parity. Replace pending
entries with concrete implementation and verification as each area lands.

Core parity milestone: 28 iPhone simulator unit tests pass. A development-signed
arm64 build succeeds for the separate native bundle ID. UI parity QA continues.

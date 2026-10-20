# Native Mac implementation and verification

The expanded native implementation builds against the existing Rust daemon.
The combined Swift suite passes 169 tests (two opt-in tests skipped). A separate
live test created a task in the real FalconDeck project, received two streamed
replies in that task, changed its title and verified archival with a fresh read.
“Implemented” below means the source and daemon wiring are present; complete UI
acceptance and permission-dependent hardware checks remain separate.

| Area | Implemented | Verification and remaining coverage |
| --- | --- | --- |
| Runtime | Attach to an existing local daemon or own an embedded Rust daemon; packaged helpers; state ownership lock; guarded quit. | Rust host ABI, state-lock and computer-use identity checks passed in focused runs. Swift-to-Rust attach and isolated start/health/shutdown smokes passed. The release Rust library also passed two isolated start/health/shutdown/restart cycles. The installed SwiftUI app attached to the existing daemon successfully. |
| Projects and tasks | Double sidebar; projects, standalone chats, pins, folders, library/archive, sorting, stages, search, drag/drop and task actions. | Navigation tests cover ordering, filters and context generation. Full sidebar interaction and restoration checks remain. See [Navigation](Sources/FalconDeckMac/Navigation). |
| Conversation | Live history, Markdown/code/media, tools, approvals/questions, models, skills/prompts, attachments, queue/steer/edit, goals/plans, find/export, fork/handoff and compact. | The expanded store passed a real new-task/send/stream/follow-up/title/archive test. Transcript, composer, attachment, recovery and extension suggestion tests pass. Full UI interaction coverage remains. See [Conversation](Sources/FalconDeckMac/Conversation). |
| Input recovery | Encrypted drafts, attachment payloads and pending submissions; persistent send identity and delivery reconciliation. | Store regression tests cover host scoping and concurrent state changes. Combined recovery tests and real AES round-trip, corruption, stale-write and file-permission checks pass. See [NativeInputStore.swift](Sources/FalconDeckMac/NativeInputStore.swift). |
| Themes and typography | All 19 palettes, system appearance, native default fonts, custom installed fonts, font weights, global and per-surface scaling, increased contrast. | Tests cover the complete catalog, palette resolution and text contrast on four content surfaces. Visual checks across themes, scales and window sizes remain. See [ThemeTests.swift](Tests/FalconDeckMacTests/ThemeTests.swift). |
| Settings | All 16 sections listed below, native search and first-run setup. | Focused preference/shortcut tests passed. Final visual and real-operation checks across settings remain. See [Settings](Sources/FalconDeckMac/Settings). |
| Remote hosts | Pairing, Keychain sessions, authenticated encrypted relay transport, chunked transfer, host-scoped IDs, reconnect/rebase and key rotation. | An isolated real Rust daemon/relay test passed pairing, read/mutation, reconnect, chunked payloads and recovery after offline key rotation. Ordinary test runs skip this opt-in integration. Remote terminal RPCs are unavailable. See [Remote](Sources/FalconDeckMac/Remote). |
| Inspector and terminal | File tree, text editing with conflict checks, Git status/diffs/actions, media/PDF preview and native SwiftTerm PTY. | Focused file/terminal tests passed. Live temporary-file read/save/conflict/traversal and real PTY execute/resize/reconnect/replay/close checks passed. Remote terminal is unavailable. See [Inspector](Sources/FalconDeckMac/Inspector). |
| Activity, usage and automations | Activity window, provider usage/reset controls, scheduled task creation/editing/runs and plugin/skill/MCP views. | Source wiring is present; full live UI acceptance remains. See [Workspaces](Sources/FalconDeckMac/Workspaces). |
| Extensions | Catalog, enablement, permissions, native declarative contributions, composer suggestions, confined compatibility panels for official Notes/Kanban, and trusted agent-tool result renderer infrastructure. | Host build/type checks and real WKWebView bridge/CSP checks passed, including Notes read/create/final save, Kanban grants, navigation and theme/font updates. Trusted result provenance/grant checks and synthetic result rendering pass. Only repository-owned bundled frontend code is compiled, matching the existing extension trust boundary. |
| Speech | Apple Speech, OpenRouter and Parakeet dictation; global shortcuts; overlay; dictionary/history/recovery; selected-text rewrite; read-aloud/realtime playback. | Dictionary, recording/recovery, target identity, anchor safety and fake-helper checks passed. Physical microphone capture, each real transcription engine, cross-app insertion, and playback still need testing with the required grants. See [Speech](Sources/FalconDeckMac/Speech). |
| Platform services | Notifications, Dock attention, completion sounds, configurable commands and permission-aware computer-use setup. | Focused platform identity/notification and shortcut checks passed. Notification delivery, Dock behavior and permission-dependent flows need final app checks. See [Platform](Sources/FalconDeckMac/Platform). |
| Updates and distribution | Sparkle check/download/install/restart UI, appcast/key validation and separate native bundle identity. | Sparkle API/type checks and configuration checks passed. A production native appcast, signed update cycle, notarized distribution and additional architecture testing remain. |

The settings sections are General, Appearance, Notifications, Conversations,
Keyboard shortcuts, Extensions, Agents, Harnesses, Connectors, Agent control,
Computer use, Voice, Models & keys, Remote access, Servers, and Backup & data.
Shared policy and runtime configuration use the existing daemon; local appearance,
shortcuts, sounds and native host credentials remain scoped to this Mac client.

Reported focused checks above were run by the implementing agents. They are
complementary to the combined Swift test run, packaged app smoke test and required
repository code review; they do not replace those final checks.

Final repository validation: `swift test --package-path mac-native-pilot -j 6`
passed 169 tests with two opt-in tests skipped. The opt-in live store test passed
separately with the two acknowledgment turns and confirmed archive cleanup.
`.agents/skills/autoreview/scripts/autoreview --mode local` completed six bounded
review passes with no accepted/actionable findings. The two completion WAV assets
were checked with `file` and `afinfo`; autoreview was skipped for that separate
mechanical asset-only commit. Background app checks passed welcome dismissal,
real-project sidebars and General settings. Complete visual interaction coverage
and permission-dependent speech checks remain; no macOS privacy grants were changed
by automation. A separate local review of the preview-updater wording also passed.

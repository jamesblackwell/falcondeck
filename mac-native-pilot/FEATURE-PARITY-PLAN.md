# Native Mac feature parity plan

Date: 20 October 2026. Baseline: desktop and native pilot at `5a08a87c`.
Status: implementation plan; this document does not authorize a production cutover.

Build a SwiftUI/AppKit Mac app that can replace the existing Tauri client for
every currently shipped Mac workflow. Keep the Rust daemon, relay, native agent
sessions, extension backend and shared protocol authoritative. Preserve the
prototype's two-sidebar layout, restore the full navigation model, and make the
interface feel consistent and finished across all settings and task states.

The prototype already loads real project/task history, creates tasks, sends and
receives messages, renders basic Markdown/code/tools, loads earlier history,
interrupts tasks and answers basic approvals/questions. It remains an early
client: it depends on Tauri's running daemon, excludes standalone Chats, keeps
drafts in memory, and lacks most desktop functionality. Its 11 focused tests and
real send/continuation smoke test establish a starting point, not parity.

## 1. Scope and completion standard

The acceptance baseline is current desktop source, including shared chat/UI
packages and Tauri host behaviour. The iOS native app is a reuse/reference source;
its mobile parity ledger is not a desktop completeness claim.

For each capability, completion means the action works, its state survives the
appropriate lifecycle, errors recover correctly, other connected clients observe
the result, and keyboard/accessibility behaviour is usable. A screen containing
the right controls is only part of the work.

Include all existing settings, standalone Chats, pins/folders, archives, remote
hosts, provider management, speech, notifications, task controls, files/review,
terminal, Activity, automations, usage, plugins/skills and extension contributions.
Keep unsupported provider capabilities visible with an explanation where the
current product does so. Preserve explicit provider decisions and permission
boundaries rather than inventing convenient defaults.

Do not expand parity to draft product concepts. The in-app browser document is a
draft; current desktop links open in the system browser. New browser tabs,
rooms, login items or a menu-bar accessory are separate enhancements unless a new
baseline explicitly includes them. Current Activity and dictation windows do
belong to parity.

Keep the side-by-side native app identity during development. Promotion to the
production app and release channel is a separate, reviewable release operation.

## 2. Proposed Mac layout

Use three primary columns, with the existing product's navigation semantics.

| Surface | Contents | Behaviour |
| --- | --- | --- |
| Navigation sidebar | Global search/new chat; Activity, Automations, Usage, Plugins, Extensions and contributed panels; global pins; Chats; ordered projects; project library; settings and connection state | Quiet, compact native rows; collapsible sections; remote-host badges; unread/attention rollups; project context menus and reorder |
| Task sidebar | Tasks for the selected project, Chats, pin scope or saved filter; project pins, virtual folders and normal tasks; search, sort, filters and archived view | Native list/outline; stable selection and scrolling; drag/drop; context menus; visible paging/load errors |
| Main workspace | Conversation/composer, or the selected main view | Compact toolbar; readable transcript; native controls; background work never takes over selection |
| Optional right inspector | Info, Changes, Files and relevant previews | Closed by default; resizable; lazy requests; preserve selected file and scope |
| Optional bottom terminal | Project-scoped terminal tabs | Resize without losing the conversation; correct focus and shortcut routing |

Start with roughly 190–230 pt navigation and 260–330 pt task-list widths; tune
against real content. Keep the conversation usable when the inspector is open:
collapse a sidebar or use a temporary inspector at smaller widths rather than
requiring five narrow columns. Persist column widths/visibility per device and
restore each scope's list position, selected task and transcript position.

Selecting a global pin opens its task and reveals its project/chat context.
Returning to the originating scope restores that scope's list. Chats aggregates
daemon-managed casual workspaces without exposing each as a project. New chat
must work independently of a project; New task uses the selected project/folder.
Do not change underlying workspace IDs or move conversation ownership to achieve
the layout.

Activity can use the task sidebar as an inbox with the selected conversation in
the main pane. Settings uses its own searchable section list inside the main
workspace; opening it should temporarily replace redundant task navigation,
then restore the prior conversation context on close. Keep Cmd-comma and the
native app menu as direct entry points.

## 3. Architecture and ownership

### Native host and Rust runtime

The packaged Tauri app currently calls `spawn_embedded` and owns a Rust daemon
inside its process on a temporary loopback port. Simply removing Tauri and
retaining the prototype's listener discovery would leave the native app dependent
on the old shell.

Recommended first implementation: a narrow Rust static-library/C ABI host bridge
that starts the existing daemon in the Swift app process. Expose bootstrap,
readiness/endpoint, active-turn count, graceful shutdown and reserved stdio-helper
dispatch. Continue using HTTP/WebSocket for normal app operations; do not create
a second FFI API for each task/settings feature.

This preserves the current computer-use process model. Built-in MCP helpers use
`current_exe()`, so dispatch their reserved arguments before SwiftUI initializes,
or configure an explicit bundled Rust helper executable. Package Deno,
cua-driver, matching skills/licenses and the Parakeet helper as appropriate.
Preserve Rust initialization, executable resolution and the user's login-shell
environment handling.

Prove this in a signed packaged spike first. Computer use currently assumes
`com.falcondeck.desktop`, uses the host process PID and checks direct-parent app
identity. Make host identity explicit for the native pilot and verify real TCC
attribution and separate signed-in-browser consent. A subprocess daemon is a
possible alternative, but it requires its own attribution/ownership proof; the
existing warning on a failed identity check is not proof that the arrangement is
safe or fully functional.

Define two launch modes: attach as a passive client to a compatible existing
daemon, or own the native runtime. Use verified discovery and an ownership/state
lock so side-by-side apps cannot start competing writers or unintentionally own
the same agent processes. An attaching client must never shut down someone
else's runtime. Provide an intentional handoff when the old app closes.
Preserve active-task warnings for quit, restart and updates. No recurring restart
jobs, broad process killing or silent daemon takeover.

### Shared Swift foundation

Extract a small `FalconDeckClient` Swift package incrementally, compiled by both
native apps. Start with wire values, transcript reducers, UTF-16 delta handling,
ordering, delivery recovery, preference writes, relay crypto/transfers and
bounded caches. Add platform interfaces for credentials, files, audio and
lifecycle. Do not copy the iOS app's large `AppModel` and UIKit/ActivityKit code
into the Mac client.

Keep Mac feature stores separate: navigation, task index, selected conversation,
drafts/delivery, preferences, hosts, automations, extensions and platform services.
Transport and expensive decoding/projection run off the main actor; publish
small, coalesced UI updates. Each conversation owns its incremental presentation
and cached settled Markdown instead of rebuilding every visible row per token.

Use a common host-aware transport contract for local daemon and encrypted relay
connections. Key entities and pending requests by host/session identity as well
as workspace/task ID. Cancellation and connection generations must prevent a
late response from one host populating another host's UI.

### State ownership

| State | Owner and migration rule |
| --- | --- |
| Conversation sessions/history | Native agents and daemon; no new FalconDeck conversation database |
| Project order/hidden/icons/colors/folders, task pins/read/archive, conversation and notification policy | Existing daemon state/preferences and mutations; preserve cross-device semantics |
| Appearance/fonts, shortcuts, thinking display, default Queue/Steer, panel widths, local navigation and sound choice | Device-local settings with explicit import into native storage; do not silently synchronize additional settings |
| Unsent text/attachments and uncertain submissions | Durable native input store with atomic writes, revision/generation protection and appropriate file/key protection |
| History previews and media thumbnails | Bounded disposable caches; fresh daemon state wins; eviction/corruption is recoverable |
| Remote-host metadata and credentials | Local host catalog plus namespaced OS Keychain secrets; retain trust identity and explicit repair/forget behaviour |
| OpenRouter key, provider credentials and extension private state | Existing daemon/CLI/extension owners; Swift uses status and authorized mutation APIs |
| Dictation settings, audio recovery/history and dictionary | Local platform services/files with existing retention and deletion semantics; network speech remains daemon-owned |

Do not import stale replay cursors, transient approval decisions or a stale
"running" flag as authoritative from a disk preview. Do not overwrite a whole
settings file from a stale screen when the current API supports partial or
revision-checked updates.

## 4. Sync and connection requirements

1. Represent startup, restore, connected, reconnecting, offline, incompatible
   version and failed-detail states separately. Existing content should remain
   readable during transient connection loss. Never leave a permanent spinner
   after a failed request or treat empty partial hydration as empty history.
2. Subscribe before relying on mutable bootstrap state; reconcile snapshots,
   paged history and intervening events. Preserve sequence/idempotency and
   UTF-16 offset rules. Recover gaps from authoritative detail/snapshot reads.
3. Port the iOS/native ordering and touched-row safeguards: older pages cannot
   resurrect archived tasks, undo pins or overwrite newer summaries. Absence
   from a page means not loaded, not deleted. Preserve archive tombstones and
   connection/index generations.
4. Restore selected project by stable host/path when daemon workspace IDs change;
   retain explicit task/draft navigation. Fetch selected history first, then
   bounded background work; hidden/collapsed projects must not trigger a storm
   of detail requests.
5. Keep local projected snapshots and paged detail initially. Remote transport
   should reuse the existing compact `sync.index`/`sync.threads` RPC behaviour.
   Those are not currently equivalent local REST endpoints. Add a thin local
   binding to the shared implementation only if measurements justify it; do
   not invent a separate pagination protocol just for Swift.
6. Implement backoff with a stable-connection reset, connection deadlines,
   sleep/wake recovery, network-change handling, restart on a new port, and
   bounded queues/cache work. The event reader must stay responsive during
   history/media decoding and large tool output.
7. Persist submission identity before sending. A timed-out mutation is uncertain,
   not a rejection: reconcile its daemon echo/queue/history before offering a
   deliberate retry. Never blindly resend accepted input or an approval.
8. Support concurrent local/native/mobile/remote clients. Coalesce mark-read
   updates and preserve desktop-presence policy so the native app does not
   cause duplicate phone pushes or suppress them while the user is away.
9. Preserve signed pairing authority, Keychain identities, encrypted chunks,
   transfer bounds, key generations, revocation and replay-truncation recovery.
   A reset/pruned replay requires a fresh snapshot; client assumptions must not
   require the relay to retain all history.
10. Keep loopback Host/Origin checks and extension permissions intact. Native
    hosting is not a reason to expose the local API to arbitrary websites or
    send credentials into a renderer.

## 5. Sidebar and task management parity

| Area | Work required |
| --- | --- |
| Pins and Chats | Global pin section; project pins and their mutual-exclusion rules; owning-project glyphs; collapse/selection reveal; independent New chat; aggregate casual workspaces |
| Projects | Daemon order, drag reorder, hide/show, local collapse, categorical colors, automatic/folder/domain icons, host badges, offline state, open-folder and import flows |
| Library | Closed/recent projects and reopen; preserve separate meanings of Hide, Remove from Sidebar/close, and Forget; do not delete sessions when closing navigation |
| Folders | Single-level create/rename/delete/collapse, membership, drag/drop to folder/root, contextual move; deleting a folder returns tasks to the project root |
| Task actions | Rename and suggest title; global/project pin; read/unread; stage/custom stage; copy working directory/session ID; archive/restore/permanent delete; fork/handoff; isolated checkout lifecycle |
| Ordering and search | Recency/priority/name ordering; stable read-state demotion; loaded-scope search plus real cross-task message search/snippets; paging and errors; archive/filter modes |
| Attention | Running, pending approvals/questions, failures, unread, stopped-by-shutdown and collapsed-project rollups; native context-menu action order and busy-task restrictions |
| Navigation | Keyboard row movement, previous/next task, command palette, scroll restoration, correct right-click selection, drag/drop and full accessibility labels |
| Extension contributions | Stage decorations, contributed filters/actions and live updates; disable/revoke removes contributions without restarting |

Acceptance: use one dataset with chats, both pin scopes, folders, hidden/closed
and remote projects, archived tasks and every attention state. Perform the
mutations in the native app and verify them in Tauri/mobile after reconnect.
Opening a task or marking it read must not move it under the pointer.

## 6. Composer and conversation parity

**Composer and task setup.** Implement capability-driven provider/model search,
favorites, reasoning effort, permissions/approval policy, sandbox,
collaboration/plan modes and service tier/Fast. Persist per-provider choices and
support explicit reset values. Do not hardcode the product to Codex/Claude.
Provide project/host/folder/location selection for new tasks, existing branch or
new branch selection, uncommitted-change context and optional isolated checkout.

**Input lifecycle.** Durable per-task and new-task drafts; caret, selection and
undo; attachment preparation and failure recovery; no late creation/send callback
stealing navigation. Queue/Steer preference and alternate action, queue edit,
remove, steer and drag reorder; truthful pending/accepted/queued/error states.
Stop, interrupted-on-shutdown resume/dismiss, compaction, edit/resend and retry
branching, same-/cross-provider forks/handoffs and permission preservation.

**Agent context.** Slash commands, skills/saved prompts, quoted selections and
prompt composition, project/branch context, active plans, goals with budgets and
usage, pause/resume/stop/clear, extension follow-up suggestions, and isolated task
Merge/Create PR/shipping actions with conflict recovery.

**Interactive input.** All approval choices/scopes, plan approval, multi-question
and free-text input, MCP elicitation and supporting command/path/evidence.
Requests that await a decision stay visible. Prevent duplicate responses and
reconcile decisions made on another client. Never broaden access because an
older daemon omitted a field.

**Transcript.** Match grouping/work-session summaries, five tool density modes,
four thinking modes, long-user-message collapse, expansion controls, plans,
diffs/file changes, command/MCP/provider tool output, hooks/guardian/subagent
activity, web-search/citations, compaction, service/operational notices, artifacts,
reviews, images/audio/realtime and inspectable unknown-item fallbacks. Treat
each current wire kind as an explicit fixture.

Render Markdown, syntax-highlighted code, tables, links/local paths, images,
documents and supported diagrams. Preserve full source for unsupported Mermaid
syntax; common-flowchart support alone must not be advertised as arbitrary
diagram parity. Preserve copy/export, in-conversation find with match navigation,
cross-task search with snippets and command-palette actions. Export must either
load complete history or clearly label a partial export.

**Scroll and text quality.** Follow new output only while the user is following
the bottom. Preserve viewport during history prepend; keep task-specific
scroll/disclosure state; offer a reliable jump-to-latest control. Text should be
selectable, searchable and copyable across rich blocks where practical. Use an
AppKit text view where SwiftUI cannot provide the required IME, editing or
selection behaviour.

Acceptance: real Codex, Claude and one configured ACP harness; send/queue/reorder/
steer/interrupt/resume, cross-client approval, failed attachment send,
edit/retry/handoff, goals and isolated shipping. Sustain streaming into a long
transcript while typing, selecting text, scrolling and switching tasks.

## 7. Complete settings inventory

Retain the current four groups and all 16 sections. Use native form controls,
search over both sections and individual settings, direct section/setting links,
Cmd-F search focus and clear pending/saved/error feedback. Every setting must
change actual behaviour, use its existing owner, survive the relevant restart,
and respond to changes arriving from another client when it is shared.

| Section | Full parity scope | State/integration |
| --- | --- | --- |
| General | Automatically continue stopped sessions; version/channel/last check; manual/background update checks; release notes; download progress; install/restart protection; rerun onboarding | Daemon auto-resume preference; local onboarding; native updater/lifecycle |
| Appearance | System/light/dark; separate light/dark palettes; UI/chat/mono fonts including custom families; match-chat-to-UI; global and sidebar/chat/code scales; UI/sidebar/chat/code weights; previews/reset | Device-local native appearance store; shared semantic palette tokens and accessible contrast |
| Notifications | Master switch; completed turns; approvals/questions; failed turns; suppress phone push while desktop active; completion sound, selection and preview | Daemon notification policy; native presence heartbeat, UserNotifications, local sounds |
| Conversations | Running follow-up Queue/Steer; all five tool modes; four thinking modes; read-only tool grouping; collapse long sent messages; expand/collapse-all; auto-open approvals/errors/failed tests/first diff | Daemon conversation preferences; local Queue/Steer and thinking display. Rust currently does not persist thinking as a preference |
| Keyboard shortcuts | Search by command or captured chord; multiple bindings; recording/removing; conflict validation; reset one/all; focused composer/terminal/global routing | Migrate all current command IDs and local overrides; native menu and AppKit command dispatch |
| Extensions | Installed search/groups, source/version/status/errors; enable/disable; individual grants; confirmation when enabling requires permission | Daemon extension catalog/permission mutations; native contribution hosts |
| Agents | Project agent/auth/model status; built-in/recommended adapters; custom ACP id/label/command; resolved binaries and malformed entries; add/remove | Provider APIs and revision-checked `providers.json` writes; dynamic catalogs |
| Harnesses | Local/SSH target; paths and conflicting installs; versions/accounts; check updates; install/upgrade/repair; Upgrade all queue; job logs; sign-in assistance | Existing harness inventory/jobs and remote commands; preserve refresh rules and do not refresh another CLI's OAuth tokens |
| Connectors | Global/project/inherited views; command/URL transport; args/env/headers; enable/provider restrictions; JSON import; add/remove; scope-safe writes | Existing connector files/APIs; stale scope changes cannot overwrite another project's file |
| Agent control | Global enable; provider inheritance/overrides; context injection; timezone; elevated automations; confirmation policy; recent control audit | Existing control get/execute operations, expected revisions and idempotency |
| Computer use | Enable; agent cursor; telemetry; separate signed-in-browser consent; Accessibility/Screen Recording status/request/System Settings; health/version/error; capture test/black-frame recovery; driver/app restart | Existing Rust policy/supervisor plus stable native host identity and permission UI |
| Voice | System-wide dictation/re-paste; hold/toggle shortcuts; microphone; Apple/OpenRouter/Parakeet; model/fallback; automatic cleanup; dictionary; selected-text rewrite/model/effort/prompt; history/retention/retry/delete | Extract existing Mac native/Rust speech services; see voice workstream below |
| Models & keys | OpenRouter key status/save/remove/get-key link; title style prompt/save/reset; suggestion model/save/reset; automatic-title provider order and per-provider models/auth/reset | Existing daemon secret API and title/utility preferences; never duplicate or expose the underlying secret |
| Remote access | Pair device; code/link/expiry/copy; regenerate grant without revoking existing devices; trust list/last seen/status/revoke; relay status/refresh/errors | Existing local daemon pairing/trusted-device APIs |
| Servers | SSH/manual provision with job logs; pair code/relay; name/enable/status; repair; restart remote daemon; add remote project; remove | Local host metadata + Keychain; daemon SSH/provision commands + encrypted host transport |
| Backup & data | Export daemon plus local client settings; inspect import preview/counts/found-missing paths; restore; native local reset/onboarding; preserve full-daemon stash guidance | Existing backup APIs plus a versioned native settings payload; no destructive reset hidden behind cache reset |

Usage remains a separate main/sidebar surface, not a seventeenth Settings page.
Implement installed-provider usage, plan/limit windows, resets/credits where
offered, refresh/error/auth states and current host context. Agent Plugins/skills
catalogs also remain distinct from FalconDeck Extensions.

Migrate current local state deliberately: appearance, shortcuts, Queue/Steer,
thinking, sounds, sidebar disclosure, selection, panel visibility, hosts,
dictation and onboarding. The old backup exporter and shortcut implementation
reference different shortcut keys; verify the real stored keys instead of
assuming the export is complete. Prefer a versioned export/import path produced
by the old trusted shell over scraping arbitrary WebKit databases. Preserve the
source copy and make imports repeatable without overwriting newer native edits.

## 8. Voice and audio workstream

Reuse the existing Objective-C capture/event-tap/paste bridge and Rust speech
orchestration where it preserves proven behaviour. Remove `AppHandle`/webview
dependencies behind platform interfaces. The iOS recorder is useful reference
for recovery and audio state, not a replacement for system-wide Mac dictation.

1. Input-only microphone capture, device chooser/refresh and disconnected-device
   fallback; starting recording must not alter another app's playback route.
   Microphone/Speech/Accessibility grant and denial/recovery states must be real.
2. Apple Speech, daemon-backed OpenRouter transcription with model/fallback/key
   configuration, and Apple-Silicon/macOS-gated Parakeet helper setup, download,
   progress/retry/reinstall, loaded state and idle-unload policy.
3. Hold-to-dictate and toggle activation, configurable modifier/chord shortcuts,
   existing modifier-delay semantics, normal Command-shortcut coexistence,
   Escape cancel and Cmd-Shift-V re-paste.
4. Nonactivating recording/transcribing/rewriting/paste/recovery panel across
   displays; metering, Copy, Retry, Discard, Undo and truthful error states.
5. Crash-safe capture/export, validated retained audio, pending-take persistence,
   restart recovery, retention choices 0/1/6/24 hours, retry by engine/model,
   delete/clear and secure cleanup. Persist recovered text before retiring its
   source recording.
6. Safe external insertion: validate the captured app/focus/destination; preserve
   and restore clipboard only while ownership still matches; keep a copyable
   transcript when delivery cannot be confirmed. Correction replacement must
   validate the original range/content or fall back to a recovery action.
7. Correction dictionary with phrase/whole-word/removal rules, longest-match and
   no cascading replacements, validation and the current 100-entry limit.
   Voice rewrite of selected text, separate shortcut/clash checks, rewrite
   model/effort/custom prompt/reset, optional automatic cleanup and explicit Fix.
8. Native composer insertion uses the captured task/draft/caret identity and
   preserves text typed during transcription. It does not round-trip through
   external-app paste.
9. Separate read-aloud and agent realtime-audio playback. Port compatible Swift
   preparation/PCM state through Mac AVFoundation adapters; bound buffers,
   validate formats, cancel stale requests and keep Stop effective.

Acceptance: native composer, TextEdit, a browser editor and terminal; both
activation modes; all supported engines; interrupted capture/export/network
requests; device unplug; permission denial; clipboard/focus changed by the user;
dictionary, rewrite, correction, retention and retry. Physical Mac checks are
required for permission, device and cross-app behaviour.

## 9. Other workspaces and native integration

**Activity.** Preserve needs-response/failed/working/ready/recent grouping,
counts, inline preview/reply/approval/read actions, keyboard navigation, pinned
behaviour and a separate native Activity window backed by the same stores.

**Automations.** Reuse the native iOS editor/store and daemon control APIs.
Include local and enrolled-host aggregation; current/managed task targeting;
once/interval/cron/timezone; conditions/no-action handling; provider/execution/
connector requirements; concurrency/misfire behaviour; run/edit/enable/pause/
resume/delete/history/errors and legacy schedule preservation. Do not create a
second scheduler in Swift.

**Plugins, skills and prompts.** Port current catalog/search/install/enable/
remove/connection/OAuth flows, available-account/harness restrictions and
permission/error feedback. Keep OAuth and pairing URLs on their required
external-browser route.

**Review and files.** Info, Changes and Files; branch/isolation/origin/path;
Git status/totals/filter/review action/unified diff/previous-next; lazy indexed
tree with overlays and previews. Support source/image/Markdown/PDF/media
previews and explicit edit/save. Retain opaque file-version conflict checks,
canonical-root and external-symlink restrictions, existing 1 MB source read/write
limits, 20,000-path listings and 500-result search caps. Coalesce passive Git
refresh; user refresh stays immediate. Local open/reveal/editor/save-as and
remote roots must target the correct host.

**Terminal.** Recommend testing the native AppKit `TerminalView` from
[SwiftTerm](https://github.com/migueldeicaza/SwiftTerm/blob/main/README.md) against
the current daemon PTY stream. Bind its delegate to the existing PTY protocol;
do not use a local-process terminal view to create a second terminal backend.
Prove ANSI/alternate screen, mouse, Unicode, IME, paste, resize, scrollback,
search, tab lifecycle, reconnect/output sequence handling and focused shortcuts.
Pin a reviewed compatible release. If it cannot meet parity, retain the existing
xterm renderer in a confined leaf WKWebView as an explicit temporary rendering
choice; the rest of the workspace remains native.

**Extensions.** Render declarative contributions natively using shared public
contracts. For existing official trusted React panels such as Notes/Kanban and
custom agent-tool frontends, plan a confined WKWebView compatibility host with
the existing public SDK projection/action bridge. This is the default parity
route; rewriting every extension into Swift is not a prerequisite. No general
shell bridge, secrets or unrestricted daemon handle enters that webview. Bind
actions to extension/view/host generation and enforce daemon permissions;
disable/revoke must retract views/tools immediately. Update the documented
client-specific trusted-frontend contract before changing host behaviour.
An "open on desktop" mobile fallback is not Mac feature parity.

**Mac conventions.** Native menus, custom shortcuts and contextual focus,
folder/save panels, drag/drop, clipboard, external URL validation,
NSWorkspace reveal/editor actions, app/window reopen, separate Activity and
dictation windows, notifications with task routing, sounds, presence/lock/idle
handling, and onboarding with real harness/auth/grant states. Do not introduce
tray/login-item behaviour merely because other Mac apps have it.

## 10. Delivery milestones

Each milestone should leave a usable app and land small completed commits on
main. Parallel work uses clear file ownership and shared interfaces. Avoid a
large replacement branch that is integrated only after every surface exists.

| Milestone | Deliverables | Completion check |
| --- | --- | --- |
| M0 Platform proofs | Signed Swift→Rust host/bootstrap/helper dispatch; Cua attribution and bundle identity; dictionary/history/dictation extraction seam; terminal renderer spike; official extension compatibility spike; native update prototype | With Tauri closed, a packaged build runs a real task, its built-in MCP tool, an extension action and computer-use health test; terminal and update approach have working small proofs |
| M1 Standalone foundation | Native-owned runtime, sidecar packaging, ownership/discovery/handoff, lifecycle, shared Swift foundation and host-aware transport | Cold start, attach, close/reopen, deliberate quit/restart and crash recovery; no duplicate daemon/state writers; existing history and paired devices remain usable |
| M2 Sync, storage and settings foundation | Robust reconnect/hydration/paging/delivery; durable drafts and attachments; disposable caches; preference ownership/write adapters; native settings navigation/search; appearance and conversation preferences | Restart during draft/send and reconnect during live history; cross-client updates converge; settings actually affect rendering and survive restart |
| M3 Navigation parity | Two-sidebar layout; global/project pins; Chats; folders; ordering/icons/colors; hidden/closed/library/archive flows; task actions; filters/search/palette; keyboard navigation | Full sidebar fixture and cross-client mutation checks; no pointer/scroll jumps; long lists remain responsive |
| M4 Conversation parity | Full composer capabilities, queues including reorder, rich transcript kinds, approvals/MCP elicitation, goals/plans, attachments, search/export, branching/handoff/isolation/shipping | Real Codex/Claude/ACP scenario matrix; uncertain sends and cross-client approvals; sustained long-chat streaming while typing and selecting |
| M5 Settings and administration | Finish all 16 settings sections; Usage; provider/harness/connector control; notifications/presence; remote access, enrolled servers/Keychain and backup migration | Every inventory row has working controls and persistence checks; remote operations target the right host; import/restore and local reset preserve their intended boundaries |
| M6 Voice parity | Native global dictation/rewrite overlay and shortcuts, all engines/setup, mic/permissions, dictionary/history/recovery, read-aloud/realtime audio | Complete physical-Mac voice matrix; no lost recordings/drafts or incorrect focus/clipboard replacement |
| M7 Workspace and extension parity | Activity/detached window, automation editor/history, plugin/skills catalog, review/files/editing/previews, terminal tabs, declarative and official trusted extension hosts | Existing daily workflows complete inside native; file conflicts safe; real terminal applications and Notes/Kanban/actions work; revocation immediate |
| M8 Polish and performance | Consistent theme/type/density, toolbar/sidebar/composer refinement, native text behaviour, accessibility, reduced-motion/transparency, command discoverability, complete empty/loading/error states | Matched release-build measurements meet budgets; keyboard/VoiceOver pass; no regressions from adding settings/speech/advanced panels |
| M9 Release and cutover | Signed/notarized architecture builds, updater/feed, migration, permission continuity, installer health/rollback, production identity transition and documentation | Upgrade from a prior native build and migrate from Tauri; verified old/new/mobile compatibility; only then promote the native release |

M0 proofs establish the approach; they are not full implementations. Voice and
advanced-panel development can proceed alongside M3–M5 after the host and shared
interfaces settle. Appearance and key interaction polish start in M2/M3 and are
reviewed in every milestone; M8 is the final consistency/performance pass.
The Voice settings section is only complete when its M6 services work. The
Extensions and automation controls are only complete when their M7 surfaces work.

Suggested parallel lanes after M1/M2: navigation; conversation/input;
settings/admin/hosts; voice/platform; advanced panels/extensions. Keep changes
to the shared transport/reducer under one owner and coordinate interfaces before
parallel UI work. Integration and real multi-client testing continue throughout.

Recommended everyday-use checkpoint is M4 plus complete basic appearance,
notifications and model/agent controls. This permits serious native use while
the remaining milestones proceed; it is not the full-parity release.

## 11. Polish and performance acceptance

Use the current FalconDeck design tokens and palette catalog, native typography
and controls, restrained accent, clear contrast and compact consistent chrome.
Theme all surfaces including dialogs, terminal, code, extension frames and
speech overlays. Settings font/scale/weight choices must affect the intended
surface without breaking selection or layout. Test system/light/dark, custom
fonts, large text, Reduce Motion/Transparency, high contrast, VoiceOver and
keyboard-only navigation.

Measure the optimized native build and optimized Tauri build on the same Mac,
with the same daemon/project/history and renderer settings. Separate app startup
from daemon restore and agent response latency. Record cold/warm launch, time
to first usable task, idle/streaming CPU, memory, frame hitches, typing and task
switch latency, audio setup and reconnect recovery.

Proposed budgets to validate on named baseline hardware: ordinary local UI
feedback within 100 ms; sustained visible scrolling near display refresh without
repeated >50 ms main-thread stalls; warm task switching from cache within 100 ms;
idle native CPU at or below the matched Tauri workload; bounded memory across
repeated task/host changes. These are acceptance targets, not measurements from
the prototype. Set startup/memory budgets after the M1 baseline; include renderer
helpers when reporting total client cost.

Use a reproducible workload with thousands of tasks, a 1,000+ item transcript,
large code/tool output, repeated history paging and multiple streaming tasks.
Only visible/new content should be projected/decoded/rendered as needed. Avoid
full-list sorting per token, unbounded caches, persistent polling for settled
screens or microphone resources while voice is idle.

## 12. Verification and release decisions

Track each inventory row against its implementation and focused verification
scenario as it lands. Reuse the existing iOS reducer/delivery/order/cache fixtures
and desktop scenarios rather than cloning every test mechanically. Add focused
regressions for actual races and failure boundaries. Significant runtime changes
receive the repo-local autoreview, with findings verified in the real path.

Required integration scenarios include two clients editing preferences/folders;
new sends and approvals across reconnect; slow/large history alongside Stop;
daemon restore and port changes; Mac sleep/wake; relay revocation and pruned
replay; local and remote projects with similar IDs; file save conflicts; key/
permission denial; update/restart with active tasks; and voice crash recovery.
Use isolated fixtures for destructive/import/delete flows and real packaged
checks for grants, signing, native windows and notifications.

Resolve these before production cutover:

- **Minimum macOS and Intel support.** Tauri currently supports macOS 12 and
  ships Intel/Apple Silicon; the native pilot targets macOS 14. Keep 14+ for the
  pilot, build Intel where dependencies support it, and explicitly choose a
  macOS 12/13 compatibility implementation or continued legacy support before
  claiming the same supported-device coverage. Gate Parakeet separately.
- **Updater.** Recommend [Sparkle](https://sparkle-project.org/documentation/)
  for the native app, subject to the M0 packaged proof. It supports native Mac
  apps and signed appcast-based delivery; existing Tauri `latest.json` and its
  signature format are not a drop-in native update feed. Add a separate pilot
  channel/appcast and signing setup, then test the deliberate production
  transition. Do not point stable users at an unfinished pilot.
- **Identity and local migration.** Decide production bundle ID, Developer ID,
  data directories, Keychain namespaces and permission continuity together.
  Keep native-pilot state separate until import/cutover is tested. Never reuse
  another app's consent merely because the bundle name looks similar.
- **Terminal and trusted panels.** Accept the renderer/compatibility results
  against existing workflows before marking those capabilities complete.

Shipping is a separate action after implementation and verification. Keep a
working Tauri recovery path until migration/update/runtime ownership is proven.

## 13. Source map

| Reference | Purpose |
| --- | --- |
| [Design system](../DESIGN.md) | Product terminology, theme/type, context menus, folders, chrome |
| [Desktop Settings routing](../apps/desktop/src/components/SettingsView.tsx), [settings index](../apps/desktop/src/components/settings/settings-utils.ts) | Exact 16-section inventory and setting search targets |
| [Desktop sidebar](../apps/desktop/src/components/Sidebar.tsx), [shared workspace sidebar](../packages/chat-ui/src/components/workspace-sidebar.tsx) | Navigation and contextual behaviours |
| [Desktop app](../apps/desktop/src/App.tsx), [native host](../apps/desktop/src-tauri/src/lib.rs) | Main surfaces, integration, lifecycle, host commands |
| [Daemon connection](../apps/desktop/src/hooks/useDaemonConnection.ts), [shared client](../packages/client-core/src) | Snapshot/events/detail/hydration/reconnect contracts |
| [Protocol](../crates/falcondeck-core/src/lib.rs), [HTTP API](../crates/falcondeck-daemon/src/api.rs), [standalone entry](../crates/falcondeck-daemon/src/main.rs) | Authoritative types, local routes and helper dispatch |
| [Native iOS parity](../ios-native-pilot/PARITY.md), [native data](../ios-native-pilot/FalconDeckNative/Data), [performance](../ios-native-pilot/PERFORMANCE.md) | Reusable Swift state, tests and observed optimizations |
| [Chat UI](../docs/CHAT-UI.md), [keyboard](../docs/16-keyboard-shortcuts.md) | Conversation/interaction expectations |
| [Dictation](../docs/18-desktop-dictation.md), [Mac capture bridge](../apps/desktop/src-tauri/src/macos_dictation.m) | Full global voice and recovery behaviour |
| [Computer use](../docs/COMPUTER-USE.md), [host supervisor](../crates/falcondeck-daemon/src/app/computer_use.rs) | Consent, identity, process attribution and bundled driver |
| [Harnesses](../docs/HARNESSES.md), [extensions](../docs/EXTENSIONS.md) | Existing APIs, permissions and client-specific host contracts |
| [Files/review](../docs/17-desktop-code-review.md), [terminal frontend](../apps/desktop/src/components/TerminalPanel.tsx) | Review constraints and terminal lifecycle |
| [Updates](../docs/13-desktop-updates.md), [release workflow](../.github/workflows/release-desktop.yml) | Current packaging/update baseline |
| [Browser draft](../docs/IN-APP-BROWSER.md) | Explicitly deferred product scope |

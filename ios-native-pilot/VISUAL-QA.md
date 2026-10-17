# Native visual polish — 17 October 2026

The reference is the running Mac app, `DESIGN.md`, and the Expo sidebar,
conversation, composer and pairing implementations. This pass changes only the
standalone native client. It does not deploy the daemon, relay or released apps.

## Layout changes

- Plain, single-line task rows replace grouped sidebar cards and provider subtitles.
  Pins retain 44-point touch targets. Projects and folders precede Chats.
- Archive moves to secondary options; the persistent connection row is removed.
  A compact title, search, Settings and Options replace oversized/duplicate chrome.
- Project task creation sits beside the project header. Selected tasks remain
  visible beyond the normal page limit; opening one from Activity reveals its folder.
- Model/reasoning and task options use stable sheets. Menus retain their authored
  order instead of reversing near the bottom edge. Accessibility text gets full-height
  option sheets, including the same text-size preference as the workspace.
- Repeated assistant labels/actions and oversized collapsed tool cards are removed.
  Actions remain on the last assistant response per turn and in message context menus.
- The composer keeps model names on one line and fixed-size, accessible controls.
  Palette-tinted glass and an opaque, bounded request area improve separation from
  the transcript. Multiline approval commands remain scrollable; local transcript
  expansion stays available offline.
- Conversations keep their latest response visible through Markdown reflow. Reading
  activity or expanding a long message disables following; Jump to latest resumes it.
- The transcript uses reusable native list cells with plain styling. Rich Markdown
  retains its intrinsic height, and scroll tracking updates only the jump control.
- Activity uses a dense list; empty states occupy the pane instead of a large card.
  Disclosure changes use a short native spring and respect Reduce Motion.
- Working markers use a native symbol pulse. Repeating a view-level animation
  previously let the marker drift away from its label during transcript reflow.

## Screen and state checks

Screenshots were inspected after interaction, including contact sheets and full-size
checks of the sidebar, conversation, requests and larger-text layouts. The local,
ignored `artifacts/polish-2026-10-17/index.html` gallery retains the captures.
It contains 97 screen/state captures across the four device/text configurations;
landscape captures are rotated for viewing without changing their contents.

| Area | Exercised states |
| --- | --- |
| Sidebar | Five pins; project/folder hierarchy; Projects before Chats; collapse; search/clear; selected task navigation |
| Sidebar options | Sort choices; sheet dismissal into project order; secondary archive entry |
| Projects | Context menu, icon/visibility options, project order and cancellation |
| Conversation | User/assistant messages, commentary, tool groups, Markdown, code, tables, flowcharts, running status, latest/older reading positions |
| Composer | Idle/running, keyboard focus and first send; model/reasoning; task settings; attachment menu order/anchor |
| Task options | Compact actions, rename disclosure, transcript display controls and goal navigation |
| Goals | New editor, create, active controls, pause/resume controls and stop |
| Requests | Multiline command preview bounds, approval choices, multiple requests, question sheet and cancellation |
| Activity | Needs-input, running and recent task sections |
| Pairing | Scan-or-enter layout, manual validation, cancellation; existing automatic scan/link regressions remain covered |
| Settings | Appearance, Conversation, Notifications, Speech, Connections, connection log, Developer, About |
| Extensions/archive | Empty-state presentation; live extension frontend/hardware behavior is outside this visual fixture |
| Landscape | Automation creation/save and conversation navigation/composer bounds |

The suite has eleven distinct UI flows, exercised across full and focused runs on
phone and iPad. Additional checks use a 375-point iPhone SE viewport and a larger
accessibility text size. The landscape test asserts landscape dimensions. Tests
use local sample conversations/automations/goals and do not send production turns.
All 104 native unit tests pass, including new per-turn message-action regressions.
Long-message expansion, Jump to latest and keyboard resizing have real UI checks.
The keyboard regression checks the reply's bounds above the composer: hit testing
alone can report text as reachable even when the floating composer covers it.

Repeated relaunch/scroll testing exposed an intermittent iPad lazy-stack layout
loop that single passes missed. CPU samples identified repeated rich-content
layout. The transcript now uses native list cells, with intrinsic Markdown sizing
and isolated scroll state. Three repeated iPad scroll runs pass. The regression
traverses older rich content before returning to the latest response; keyboard
resizing and long-message expansion are checked separately.

## Review and device handoff

Repo-local Autoreview ran per significant commit. The conversation rendering review:

```sh
.agents/skills/autoreview/scripts/autoreview --mode commit --commit cf190f51 --max-priority P2 \
  --dataset ios-native-pilot/FalconDeckNative/Features/ConversationView.swift \
  --dataset ios-native-pilot/FalconDeckNative/Design/MarkdownView.swift \
  --dataset ios-native-pilot/FalconDeckNative/Features/TranscriptRow.swift \
  --dataset ios-native-pilot/FalconDeckNative/Data/ChatSession.swift
```
The initial compact-navigation finding was rejected against RootView's explicit
preferred-column binding and passing phone navigation/hit-testing evidence. Two
accepted findings—multiline command overflow and offline expansion being disabled—
were fixed. Manual long-message expansion was subsequently covered and fixed
in `7c6a645f`, which also reviews clean. `e5b80841`, `8d2cd82b`, `f0f77a51` and
`b8151041` review clean with no actionable P0–P2 findings. The `e7379ebf` review
identified the missing keyboard resize handling; a bounds regression reproduced it
before the fix. The final rendering fix, `82eb9a7c`, reviews clean with no
actionable P0–P2 findings. Adjacent view/owner sources were included as datasets.
The symbol-animation fix, `bb912ec0`, and subsequent scroll refinements
`abcab26d`, `c09e521d`, `7597d548` and `cf190f51` also review clean with no
actionable P0–P2 findings.
The landscape regression extension, `7b8fcd62`, reviews clean as well.
The documentation-only handoff used `git diff --check`; Autoreview was skipped
for those mechanical documentation edits.

The current Apple Development Debug app/widget build passes deep signature
verification and is installed on the iPhone over Wi-Fi as **Falcon Native**.
The final reinstall succeeded; launch was refused while the phone was locked.
Unlock it and open the app to test the current build.
The iPad build is ready but its locked device prevents development-image mounting.
Physical camera, microphone, speech/Live Activity and background push delivery
still need device testing. This report does not treat simulator success as proof
of those hardware behaviors.

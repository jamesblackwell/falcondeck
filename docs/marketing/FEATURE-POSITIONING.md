# Website feature positioning

Checked on 5 October 2026. This research informs the homepage feature section;
it is not a public claim that FalconDeck matches every capability of these tools.

## Comparable products

| Product | Current offering | What its public presentation makes clear |
| --- | --- | --- |
| [Conductor](https://www.conductor.build/) | Commercial desktop, cloud, and mobile agent workspace; [proprietary platform terms](https://www.conductor.build/terms) | Parallel agent work, existing subscriptions, isolated workspaces, a review workflow, and continuing from mobile. Its cloud and multiplayer features are separate capabilities, not evidence that FalconDeck provides them. |
| [Cursor](https://cursor.com/docs/agent/overview) | Commercial editor and agent workspace | Agents edit files and run commands, with a visible path from task to review. Its [web and mobile workflow](https://docs.cursor.com/en/background-agent/web-and-mobile) connects remote work to desktop review. |
| [Warp](https://docs.warp.dev/guides/agent-workflows/how-to-run-multiple-ai-coding-agents) | Terminal and agent workspace with an [open-source client](https://www.warp.dev/blog/warp-is-now-open-source); cloud services are separate | Multiple agents, terminal access, diffs, permissions, and notifications form one workflow. [Voice input](https://docs.warp.dev/terminal/more-features/accessibility) is presented as a practical way to work. |
| [OpenCode](https://opencode.ai/) | Open-source agent with terminal, editor, and desktop interfaces | Multiple sessions, provider choice, existing accounts, and privacy are explicit product features. |
| [Cline](https://cline.bot/) | Open-source editor and CLI agent | Files, commands, review, permissions, rules, skills, and recurring work are presented together. Its [provider integration](https://cline.bot/install) explicitly includes OpenRouter and user-provided model access. |
| [Vibe Kanban](https://www.vibekanban.com/) | Open-source agent workspace; the site now announces sunsetting and community maintenance | Visual examples explain planning, parallel agents, changes, and review. Use it as a presentation reference, with its current maintenance status acknowledged. |

## Positioning choices

My inference from these pages is that visitors expect to see the complete working
loop: choose an agent, organise tasks, follow execution, review changes, respond
to requests, and continue later. A single conversation mockup leaves much of that
unexplained.

FalconDeck already has useful capabilities beyond that loop. Voice should show
both input and output; OpenRouter should name what the integration actually
powers; automations, notifications, tools, and appearance should be visible.
The new section uses the site's existing HTML product illustrations, tokenised
dark panels, hairline borders, mono labels, and restrained accent colour.

The homepage describes FalconDeck on its own merits. It does not reuse competitor
copy, list unsupported features, or make comparative superiority claims.

## Implementation evidence and copy boundaries

| Homepage feature | Evidence in this repository | Boundary kept in the copy |
| --- | --- | --- |
| Agents and projects | [Agent integrations](../ADAPTERS.md), [desktop task flow](../../apps/desktop/src/App.tsx) | Coding agents retain their own accounts and capabilities. Switching agents carries context into a linked task. |
| Files, review, and terminal | [Diff viewer](../../apps/desktop/src/components/diff/DiffView.tsx), [file previews](../../apps/desktop/src/components/diff/FileView.tsx), [terminal](../../apps/desktop/src/components/TerminalPanel.tsx) | Inspect changes and give instructions in the task; do not promise inline review comments or checkpoint rollback. |
| Dictation and voice rewrite | [Speech settings](../../apps/desktop/src/components/DictationSetup.tsx), [native dictation](../../apps/desktop/src-tauri/src/macos_dictation.m) | System-wide dictation is a Mac feature. Apple Speech is on-device; cloud transcription and voice rewrite use OpenRouter. |
| Text-to-speech | [Desktop playback](../../apps/desktop/src/App.tsx), [mobile playback](../../apps/mobile/src/features/speech/readAloud.ts), [speech service](../../crates/falcondeck-daemon/src/app/speech.rs) | Read Aloud plays agent replies on Mac and iOS. It needs the OpenRouter key on the connected computer; it is not system-wide reading of arbitrary apps. |
| OpenRouter | [Speech service](../../crates/falcondeck-daemon/src/app/speech.rs), [title model settings](../../apps/desktop/src/components/settings/TitleSuggestionModelCard.tsx) | Powers optional cloud speech, voice rewrite, and requested title suggestions. The key is stored in the computer's OS credential store; optional provider usage has its own cost. |
| Automations | [Schedule types](../../apps/desktop/src/components/automation-draft.ts), [automations UI](../../apps/desktop/src/components/AutomationsView.tsx), [remote hosts](../../apps/desktop/src/hooks/useRemoteHosts.ts) | Recurring and one-off work runs on a configured computer that stays awake and online. Do not imply a managed cloud execution service. |
| Notifications | [Notification guide](../NOTIFICATIONS.md) | Completed work, questions, approvals, and errors are configurable attention events. Do not claim push titles are end-to-end encrypted. |
| Computer use | [Computer use settings](../../apps/desktop/src/components/settings/ComputerUsePanel.tsx) | Requires macOS 14 or later and user-granted permissions. |
| Tools and extensions | [Connectors](../CONNECTORS.md), [extensions](../EXTENSIONS.md) | MCP tools and agent skills retain harness support boundaries. Notes and Kanban are implemented; mobile does not expose every desktop extension panel. |
| Appearance and shortcuts | [Settings catalogue](../../apps/desktop/src/components/settings/settings-utils.ts), [design system](../../DESIGN.md) | Themes, fonts, text sizes, and keyboard shortcuts are configurable. |

The existing App Store calls to action, setup instructions, encrypted remote
access explanation, and self-hosting links remain part of the page.

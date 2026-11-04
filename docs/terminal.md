# Terminal panel

The desktop bottom panel runs daemon-owned shells (`crates/falcondeck-daemon/src/terminal.rs`)
rendered with xterm.js (`apps/desktop/src/components/TerminalView.tsx`).

## Scope

Terminals belong to whatever is selected (`terminal-scopes.ts`):

| Selection | Scope key | Shell starts in |
| --- | --- | --- |
| A bot's home conversation (current or previous) | `bot:<bot id>` | the bot's space (`space_path`) |
| Any other thread | `thread:<thread id>` | the thread's working directory (its worktree when isolated) |
| A project with no thread selected | `workspace:<workspace id>` | the project folder |

- `POST /api/workspaces/{id}/terminals` takes optional `thread_id` / `bot_id`; the daemon
  resolves the directory (`AppState::terminal_cwd`) and echoes both on `TerminalSessionInfo`.
  Clients filter `GET …/terminals` by scope with `sessionScopeKey`. Older sessions without
  either field fall into the workspace scope.
- Open/closed state is per scope and in memory (`useTerminalScopes`). Switching to a scope that
  is not open hides the panel; switching back shows it as it was.
- `TerminalDock` keeps one `TerminalPanel` per recently used scope mounted (up to
  `MAX_RETAINED_TERMINAL_SCOPES`, hidden ones `display:none` + `inert`), so scrollback, splits
  and xterm state survive a switch with no replay. Older scopes unmount and re-attach later,
  replaying the daemon's bounded scrollback (4 MB); their split layout is kept in a module-level
  map for the life of the window.
- Shells are never closed by switching or hiding. They close when the user closes a pane/tab,
  when the thread is deleted (`delete_thread`), or when the bot is deleted (`mutate_bot`
  delete). Archiving does not close them. Shells die with the daemon.
- Hidden panes dispose their WebGL addon (`suspend`) and re-create it on `reactivate`: WebKit caps
  live WebGL contexts and retained scopes can hold many panes.

## Splits

Each tab is a binary split tree (`terminal-layout.ts`); every leaf is its own daemon session in
the scope's directory. Panes render flat and absolutely positioned, keyed by session id, so
splitting or closing a neighbour never remounts a running terminal. `⌘W` closes the focused pane;
the last pane closes the tab; the last tab hides the panel and releases the scope.

## Focus

Becoming visible never takes keyboard focus. Focus moves into a terminal only on an explicit
request: `⌘J`/`⌃\`` opening the panel, `⌃⇧\`` (new terminal), `⌘T`/`⌘D`/`⌘⇧D` from inside the
panel, a tab click, pane navigation, or a click in the pane. Hiding a focused panel blurs it and
returns focus to the composer.

Why: dictation and `⌘⇧V` re-paste insert into `document.activeElement`
(`insertDictationText` in `App.tsx`). xterm's input is a hidden textarea, so before this rule a
terminal that grabbed focus on mount (auto-created after switching bots) or kept focus after
`⌘J` hid it received the dictated chat message at the shell prompt.

## Shortcuts

Terminal-context shortcuts are handled by a capture-phase window listener while focus is in the
panel, so neither xterm nor the global bindings see them. Defaults (all customizable):

| Keys | Action |
| --- | --- |
| `⌘J`, `⌃\`` | Toggle the panel for the current scope (global) |
| `⌃⇧\`` | New terminal tab from anywhere (global) |
| `⌘T` / `⌘W` | New tab / close focused pane |
| `⌘D` / `⌘⇧D` | Split right / split down |
| `⌘]` / `⌘[` | Next / previous pane; with one pane they keep chat back/forward |
| `⌥⌘←↑→↓` | Focus the pane in that direction |
| `⌘⇧]` / `⌘⇧[`, `⌘1`–`⌘9` | Cycle / jump tabs |
| `⌘=` / `⌘-` / `⌘0` | Terminal font size, shared by all terminals and stored per device; `⌃`+scroll too |

## Titles, links, height

- The daemon polls each attached session once a second (`TerminalManager::status`: PTY
  foreground process group via `tcgetpgrp`, name via `proc_name`, cwd via
  `PROC_PIDVNODEPATHINFO`; macOS only) and sends `terminal_status` frames on change. Tabs show
  the running program (its OSC title if it set one) or, at the prompt, the cwd basename.
  Double-click a tab to rename it.
- `⌘`-click opens URLs (web-links addon) and `path[:line[:col]]` references
  (`terminal-links.ts`), resolved against the pane's cwd. Files open in the default editor,
  folders in Finder. The line number is not passed on yet: no line-aware open command exists.
- Panel height is remembered globally and per scope in localStorage (`terminal-prefs.ts`).
- Colours come from `--terminal-*` CSS variables for light and dark and update on theme change.

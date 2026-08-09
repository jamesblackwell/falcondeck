# Keyboard Shortcuts

## Research inventory

Research captured on 2026-08-09. Product defaults are intentionally based on
the current ChatGPT desktop app, with interaction mechanics borrowed from the
best shortcut editors rather than copied from any one product.

| Exemplar | Useful defaults and patterns | FalconDeck takeaway |
|---|---|---|
| [ChatGPT desktop commands](https://learn.chatgpt.com/docs/reference/commands) | Command menu `⌘K` / `⌘⇧P`, settings `⌘,`, shortcut editor `⌘⇧/`, open folder `⌘O`, navigation `⌘[` / `⌘]`, text zoom `⌘+` / `⌘-`, sidebar `⌘B`, review panel `⌘⌥B`, new chat `⌘N` / `⌘⇧O`, chat search `⌘G`, in-chat find `⌘F`, adjacent chats `⌘⇧[` / `⌘⇧]`, dictation `⌃⇧D`. Settings can search by command or captured keystroke and reset bindings. | Use these as the primary Mac defaults where FalconDeck has the corresponding action. Keep command IDs independent of their bindings. |
| Current installed ChatGPT desktop build and [settings reference](https://learn.chatgpt.com/docs/reference/settings) | Enter behavior and follow-up behavior are separate settings. In the default “Enter sends” mode, `⌘Enter` temporarily inverts Queue vs Steer for one running follow-up. The inversion becomes `⌘⇧Enter` in the alternate multiline composer modes. | Model Send and Invert follow-up as separate commands. Preserve FalconDeck's current Queue default, so `⌘Enter` steers one running follow-up; let users change the default to Steer, in which case the same shortcut queues once. |
| [ChatGPT Classic for macOS](https://help.openai.com/en/articles/9703738-macos-app-release-notes) | `⌘.` stops streaming, `⌘F` finds in a conversation, and a configurable global shortcut opens the companion window. | Keep `⌘.` for Stop. Treat an OS-global launcher as a separate native feature from in-app shortcuts. |
| [Claude Code](https://code.claude.com/docs/en/keybindings) | Actions are namespaced and scoped to contexts. Bindings can be removed, changes are live, chords and aliases are supported, and validation reports duplicate or reserved bindings. | Use stable action IDs, explicit Global and Composer contexts, live updates, unbinding, and duplicate detection. Chords are deferred until FalconDeck has actions that benefit from them. |
| [Visual Studio Code](https://code.visualstudio.com/docs/configure/keybindings) | The editor lists bound and unbound commands, searches names or keystrokes, supports multiple bindings, removes or resets individual bindings, and resolves shortcuts against context. | Support multiple bindings per command and capture/search/reset in one settings surface. Keep context rules small and inspectable. |
| [Raycast](https://manual.raycast.com/command-aliases-and-hotkeys) | Inline shortcut recording auto-saves and shows conflicts immediately. Global hotkeys are visually distinguished from in-app aliases. | Record shortcuts inline and surface conflicts before saving. Do not imply that an in-app binding is system-global. |
| [Slack](https://slack.com/help/articles/201374536-Slack-keyboard-shortcuts-and-commands) | Familiar Mac conventions include `⌘N` compose, `⌘,` preferences, `⌘O` upload/open, `⌘G` global search, and `⌘F` current-conversation search. Slack exposes a shortcut reference but does not permit customization. | The conventions reinforce the ChatGPT defaults; FalconDeck should exceed Slack by making every product binding editable. |
| [Linear](https://linear.app/changelog/2021-03-25-keyboard-shortcuts-help) | A searchable shortcut help surface makes a large command set discoverable; contextual single-letter commands are reserved for focused list views. | Keep global defaults modifier-based. Context-only unmodified keys may be added later where focus is unambiguous. |

## Command set

FalconDeck v1 exposes commands for the command menu, settings, shortcut editor,
opening a project, creating and navigating chats, chat search, in-chat find,
sidebar and changes-panel visibility, text zoom, composer focus, send, newline,
one-shot Queue/Steer inversion, and stopping a running turn.

The registry is the source of truth for labels, descriptions, contexts, and
defaults. Custom values are versioned and stored locally because shortcuts are
device and keyboard-layout preferences. Empty binding arrays explicitly unbind
a command. Bindings update without restarting the app.

## Dispatch and safety rules

- Global commands do not fire from text fields unless they use Command or
  Control. Composer commands only resolve inside the prompt textarea.
- Exact duplicates are rejected across commands whose contexts can overlap.
- A binding must include one non-modifier key. Global printable bindings need
  Command, Control, or Option so typing cannot accidentally trigger an action.
- IME composition and repeated keydown events are ignored for destructive or
  one-shot commands.
- Queue/Steer is sent as part of `turn.start`; a provider without steering
  support safely falls back to queueing in the daemon.
- The shortcut editor supports command-name search, keystroke search, multiple
  bindings, per-command reset, reset-all, and explicit unbinding.

OS-global shortcuts (for showing FalconDeck while another app is active) are
out of scope for this in-app registry. They require native registration,
macOS permission/conflict handling, and a distinct “Global hotkey” label.

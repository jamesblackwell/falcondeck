# Desktop File Navigation and Code Review

## Product stance

FalconDeck's side panel is a review workspace, not a miniature general-purpose IDE. Agentic coding shifts the common path from authoring every line to locating, inspecting, comparing, and occasionally correcting files. The panel therefore prioritizes fast navigation and review while keeping editing available one action away.

## Exemplar findings

- VS Code treats Explorer and Source Control as separate but closely related surfaces. Source Control supports tree/list presentation, changed-file filtering, per-file diffs, staging, and review comments. The reusable lesson is a stable file selection with a compact repository overview, not its full SCM command surface.
- Zed overlays Git state in the project tree and makes the project-wide diff an editable multibuffer. The useful lesson is that navigation, status, and correction can share one spatial model without forcing users into a separate editor workflow.
- Codex emphasizes working-tree and last-turn review, inline comments, and opening a changed file in an external editor. The useful lesson is to keep agent review close to the task and make the scope of the reviewed changes explicit.
- Claude Code Desktop combines file-by-file visual diff review with a built-in editor, terminal, and preview. The useful lesson is that a small manual correction should not require leaving the agent app.

Primary references:

- <https://code.visualstudio.com/docs/sourcecontrol/overview>
- <https://code.visualstudio.com/docs/sourcecontrol/staging-commits>
- <https://zed.dev/docs/project-panel>
- <https://zed.dev/docs/git>
- <https://openai.com/index/introducing-the-codex-app/>
- <https://code.claude.com/docs/en/desktop>

## Implemented interaction model

The right panel has two durable modes:

- **Changes**: current Git status, insertion/deletion totals, filename filtering, review-agent action, per-file unified diff, and previous/next change navigation.
- **Files**: searchable project tree, Git status overlays, file-type-specific icons, syntax-highlighted source viewing, and an explicit edit/save mode.

File editing is deliberately secondary. Opening a file is read-only; the pencil action enables editing, `Cmd/Ctrl+S` saves, and saves use an opaque filesystem version to reject overwriting a file that changed after it was opened.

## Performance and safety constraints

- The Files request is lazy and only runs when the Files surface is opened.
- Git event refreshes coalesce for 200 ms; direct refresh remains immediate.
- Search input uses deferred rendering so keystrokes are not blocked by rebuilding a large tree.
- File search results cap at 500 and workspace listings cap at 20,000 paths.
- Collapsed tree branches do not render their descendants; long changed-file rows opt into browser content visibility.
- File reads and writes resolve canonical paths beneath the workspace, reject traversal and external symlink targets, accept existing files only, and cap built-in viewing/editing at 1 MB.
- The same filesystem and Git operations are available through the encrypted host RPC path, preserving daemon ownership for remote workspaces.

## Deliberate follow-ups

Repository-content search, inline review comments, staging/discard controls, image/Markdown previews, and side-by-side diffs are valuable extensions. They should be added as separate review capabilities rather than expanding the first file-navigation request into a complete IDE clone.

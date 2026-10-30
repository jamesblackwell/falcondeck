# Bots

Bots are named coordinators outside the project hierarchy. Each profile points
to one native agent conversation, with editable instructions and a local
document space. Tasks delegated by a bot remain ordinary FalconDeck tasks in
their target projects. The daemon stores bot metadata, not conversation history.

## V1

The desktop and browser sidebar has a Bots section. Create a new conversation or
promote an existing task (including a pinned task), choose its name and standing
instructions, and use its settings to manage documents and delegated work.
The native Mac sidebar exposes the same operations, including adding a text
document and opening its space in Finder. Harness and model settings for an
existing home conversation remain in the usual conversation controls.

New bots live under `<daemon-state-directory>/bots/<bot-id>/`, with user-owned
documents in `space/`. Promoted conversations retain their native workspace and
session; only their document space is new. No project hierarchy is required.
Documents are ordinary files, so changes made outside FalconDeck are visible on
the next read. The built-in editor supports UTF-8 files up to 1 MB and detects
conflicting saves/deletes using content versions. New filenames never overwrite
existing files. File operations reject traversal and symlink documents.

Every dispatched home turn receives the current coordinator defaults, custom
instructions, document inventory and project identifiers. It reads document
contents as needed. This context is hidden from the user message bubble and is
supplied again after native resume or compaction. Native conversation history
stays with the harness.

Bots link to tasks using `[Task name](falcondeck://thread/THREAD_ID)`, with
the exact `thread_id` returned by the coordination tools. Selecting the link
opens that task in FalconDeck, including in another project on the same computer.
The destination uses the stable ID, so renaming a task does not break old links.

Bots are encouraged to use their document space as persistent memory. A short
root-level `MEMORY.md` (or an existing memory index) holds important facts,
preferences, decisions and editable working instructions, with links to
supporting notes. Bots can organise those notes themselves, including
`memory/` or `docs/` subfolders. They consult the index when present and read
supporting notes when relevant, especially after resume or compaction. They
update useful knowledge rather than writing a log of every turn, and the user's
current and standing instructions still take precedence. No files are created
automatically. The built-in document editor lists top-level files; nested notes
are accessed directly by the agent or through the filesystem.

Current work lives in a root-level `STATUS.md` instead: priorities, in-flight
tasks (linked), what waits on the user, and recently done. Bots rewrite it in
place at checkpoints rather than appending. When a delegated task finishes, the
bot reads its summary, records the outcome in status, moves lasting decisions or
lessons into memory, and drops the task from in flight. Tasks record lasting
facts about code in their project's own docs. Each layer has one job: tasks
hold the work and its history, status holds the present, memory holds what
stays true.

The desktop Info sidebar shows a bot's name and mark, then its rendered
`STATUS.md` (about twelve lines until expanded). The document API includes
`modified_at` so the sidebar can flag status older than a day. Below it are
recent dispatches and messages, open tickets owned by the bot, and schedule
cards targeting its home or directly dispatched tasks. Schedule switches use
the read revision and retry one stale-revision conflict. Selecting a card opens
the existing automation editor. Environment and checkout rows sit in collapsed
Details. Ordinary tasks retain their existing Info layout plus recent activity.
Reads follow task updates, coalesced while streaming; there is no idle polling.

Every turn's context lists the other bots by name with the path of their
`STATUS.md`, so bots read each other's status instead of asking for updates.
Bots and tasks message each other only for decisions, blockers, review
requests, results or surprises; acknowledgements and progress narration are
discouraged.

## Tickets

Bots are told the shared ticket board exists and how to reach it, and left to decide whether and how to use it (an experiment from 30 Oct 2026). Agents may create at most five tickets a day each. See [TICKETS.md](TICKETS.md) for tools and the board.

## Icons

Each bot has a small colored shape in the sidebar: one of eight shapes and one of
the twelve categorical theme colors (`cat-1`…`cat-12`, stored as the token so
it retints with the theme). New bots take the first shape and first color no
other bot uses; profiles saved before icons existed are filled in the same way,
in order, the next time any bot is saved (clients resolve missing icons the same
way meanwhile with `resolveBotIcons`). Bot settings can change either part. An
activity marker replaces the status text while the bot or its tasks are working.

## Context files

Each bot can list text files (`.md`, `.markdown`, `.txt`) that are read fresh
from disk into every one of its turns, after its instructions and before the
document, peer and project lists. Use them for shared standing context such as
company goals, metrics or brand notes: a handful of short files, mixed per bot.
Files can live anywhere. FalconDeck suggests everything in its own context folder
(`<daemon-state-directory>/context/`, created on first use) and well-known files
at project roots (`COMPANY`, `VISION`, `MISSION`, `GOALS`, `STRATEGY`, `METRICS`,
`BRAND`, `ROADMAP`), so a project can keep its own version and different bots
can share or swap files. Tasks started by bots do not receive them; bots brief
their tasks instead. Repository instructions such as `AGENTS.md` continue to reach
every coding thread through the harness itself.

Each file is capped at 64 KB per turn; a missing or unreadable file is noted in
the turn instead of failing it. Saving a bot validates the list (absolute paths,
existing regular files, at most 20). Bot settings show each file's estimated size,
the total added to every turn (about four characters per token), a per-part
breakdown and the exact injected text. Settings can also create files in the
FalconDeck folder and edit any suggested or attached file with the same version
checks as bot documents; other paths are not readable or writable through this
editor. Bots are told to suggest changes rather than edit these files unless their
instructions say otherwise. That is guidance, not a sandbox.

## Coordination and control

Project threads find bots in the `falcondeck_list_threads` header (name and
thread id) and can message one by name: any tool's `thread_id` accepts a bot's
name, case-insensitively, when no thread has that id. They cannot read a bot's
conversation; trying returns an error that names the bot and says to message it.

Bot calls to the built-in coordination tools can select a project using
`workspace_id`: its id, exact path, or unique folder name. Calls identifying an
existing task resolve its owning workspace automatically. List and changes
calls without a project span every project, so "what is going on?" takes one
call. The per-turn context lists only the twelve most recently active projects
(path and id), since it is repeated on every turn. Ordinary tasks remain workspace-scoped. The three concurrent
children limit counts all projects together. Bot-created tasks automatically
report errors or requests for input to their home conversation. Successful turn
endings stay silent unless the bot explicitly enables `notify_parent` when
creating the task. The bot can return immediately while workers run and read
summaries at natural checkpoints. Watches rebuilt from persisted task origins
on daemon restart report only errors and requests for input; completion opt-ins
last only for the current daemon session.

“Allow this bot to start tasks through FalconDeck” is enforced when its
coordination tool is invoked. This is a FalconDeck capability restriction, not
an operating-system sandbox or a restriction on running arbitrary shell commands.
Existing harness permissions and approval rules continue to apply.

Stop work clears queued requests and interrupts the bot and its direct workers.
Deletion requires that work to be stopped, removes the profile, and archives the
home conversation. Documents remain on disk. Bulk archive skips bot homes;
individual archive/delete and project removal cannot strand a registered bot.

## Client contract

Profiles are carried in `preferences.bots`; older snapshots default to no bots.
Mutations use `POST /api/bots` with `create`, `update`, `reorder`, `stop`, or `delete`. Bots are listed in their saved order; `reorder` takes ids first to last, and bots it omits keep their relative order after those listed. Desktop reorders by dragging a row or Alt+↑/↓.
Document listing, reads and mutations use `/api/bots/:id/documents` and
`/api/bots/:id/documents/content?name=...`.

Context files use `context_files` on the profile (absent on older daemons) and an
optional `context_files` list in `update` (absent keeps the current list).
`GET /api/bots/:id/context` returns the injected text with a size breakdown;
`GET /api/context-files` lists suggestions, and
`GET /api/context-files/content?path=...` and `POST /api/context-files` read and
save them.

Paired clients use registered encrypted RPCs `bots.mutate`, `bots.documents`,
`bots.document.read`, `bots.document.mutate`, `bots.context`,
`context_files.list`, `context_files.read` and `context_files.write`. Clients hide
the context-file section when a daemon does not answer these. Profile changes publish the
existing `preferences-updated` event. No relay storage or replay contract changes
are needed.

The SwiftUI iOS client includes a Bots sidebar section. Open a bot's home
conversation or use its settings to create and promote conversations, edit
instructions and delegation access, stop work, remove a bot, and create,
import, edit or delete text documents with the same content-version checks.
Dedicated bot workspaces and home conversations stay outside the ordinary
project and pinned-task lists; promoted projects remain visible. Documents
stay on the paired computer and require a connection to read or change.

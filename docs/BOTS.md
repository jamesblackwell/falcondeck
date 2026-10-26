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

## Coordination and control

Bot calls to the built-in coordination tools can select a project using
`workspace_id`. Calls identifying an existing task resolve its owning workspace
automatically. Ordinary tasks remain workspace-scoped. The three concurrent
children limit counts all projects together. Bot-created tasks automatically
report completion or requests for input to their home conversation; the bot can
return immediately while workers run. Watches are rebuilt from persisted task
origins on daemon restart.

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
Mutations use `POST /api/bots` with `create`, `update`, `stop`, or `delete`.
Document listing, reads and mutations use `/api/bots/:id/documents` and
`/api/bots/:id/documents/content?name=...`.

Paired clients use registered encrypted RPCs `bots.mutate`, `bots.documents`,
`bots.document.read`, and `bots.document.mutate`. Profile changes publish the
existing `preferences-updated` event. No relay storage or replay contract changes
are needed.

The SwiftUI iOS client includes a Bots sidebar section. Open a bot's home
conversation or use its settings to create and promote conversations, edit
instructions and delegation access, stop work, remove a bot, and create,
import, edit or delete text documents with the same content-version checks.
Dedicated bot workspaces and home conversations stay outside the ordinary
project and pinned-task lists; promoted projects remain visible. Documents
stay on the paired computer and require a connection to read or change.

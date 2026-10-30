# Tickets

Tickets track the bigger picture: work taking hours, days or weeks, or work
other executives need to see. **Most changes should just be done. Never create
a ticket for anything under a few hours.** This is a lightweight company work
board for James and executive bots, not a checklist of coding changes.

Open **Tickets** in the desktop sidebar, or choose **Open Tickets** in the
command palette. The board groups cards by state, filters by owner, project
and priority, and hides done/dropped by default. Cards show age since creation,
owner, priority, sub-ticket count and comment count. Open a card to edit it,
add a sub-ticket or comment, or open a linked task. Change state in its menu
and save; closing requires a one-line outcome. No drag-and-drop is required.

## Records and state rules

A ticket has a sequential, human-friendly id (`T-42`), title, Markdown
description, state, priority (`P0`–`P3`, default `P2`), optional owner (bot name,
`James`, or unassigned), optional project (absolute workspace path), linked
thread ids, optional parent id, creator, last editor, creation/update times,
closing note and comments. Priorities sort from P0 (urgent) to P3 (lowest).

States: `backlog` (default), `active`, `blocked`, `waiting_on_james`, `done`,
`dropped`. Use `waiting_on_james` whenever progress depends on James. Moving
to done/dropped must supply a nonempty, single-line `closing_note` describing
the outcome in that same mutation. Reopening clears the old outcome. Creating
an already closed ticket also requires a closing note.

Sub-tickets use the same record and comments. A parent must exist. Self-parenting,
cycles, grandchildren and moving a parent with children under another ticket
are rejected. Closing a parent does not automatically close its children.
Comments have a stable id, daemon-attributed author, Markdown body and timestamp.
Keep comments concise; use them for updates that belong on the record instead
of messaging. Link execution threads using their exact native thread ids.

The daemon records creator, last editor and comment author from control request
context (origin, provider, thread, workspace, device when available). Bot home
threads resolve to the bot's name, ordinary agents to their thread id, and UI
mutations to James. Every control mutation also enters the control audit.
Authors cannot be supplied in mutation arguments.

## Storage

The daemon is the sole writer of `<daemon-state-directory>/tickets/tickets.json`.
The versioned JSON file holds records and a monotonic next id. All reads and
mutations share a transaction lock. Writes use `storage::write_atomically`
(private permissions, file sync, atomic rename and directory sync). Unreadable,
malformed or future-version files fail closed and remain untouched. This is
company work metadata, not conversation history; native agents still own
conversations. No relay storage, labels, cycles, estimates or custom fields
are added. Tickets are not currently included in FalconDeck backup exports.

## Control tools

Tickets track big-picture work taking hours, days or weeks. Most changes should
just be done; no ticket for anything under a few hours. Search existing tickets
before creating one, and keep state, owner and outcomes current.

Use the existing three control tools; no per-thread tool catalogue is added:

- `falcondeck_get` resource `tickets`: list, with `filters.owner`, `project`,
  `priority`, `state`, `include_closed`. Closed tickets are hidden unless
  `include_closed: true` or a specific state is requested. An empty owner or
  project filter selects unassigned/no project. Use `limit` (1–100) and
  `next_cursor`/`cursor` for pagination.
- `falcondeck_get` resource `ticket`, `id: "T-42"`: full record and comments.
- Discover `ticket.create`, `ticket.update`, `ticket.comment` with
  `falcondeck_search`, then read the full operation schema before executing.
- `ticket.create`: title required; optional description, state, priority,
  owner, project, parent_id, linked_thread_ids, closing_note.
- `ticket.update`: ticket_id required; omitted fields stay unchanged. Empty
  strings clear owner/project/parent_id; linked_thread_ids replaces the array.
  These mutations do not require expected_revision.
- `ticket.comment`: ticket_id and concise body required.

Example close:

```json
{
  "operation": "ticket.update",
  "arguments": {
    "ticket_id": "T-42",
    "state": "done",
    "closing_note": "Reporting is live for all executives.",
    "linked_thread_ids": ["native-thread-id"]
  },
  "idempotency_key": "close-ticket-42-launch"
}
```

The existing control enablement, validation, idempotency and audit behaviour
applies. Changes publish `control-state-changed` with domain `tickets`; the
open board refetches. Manual refresh also works after a disconnected stream.

## HTTP and remote RPC

- `GET /api/tickets`: control list envelope; the filters above are query params,
  alongside limit/cursor (HTTP defaults to 100).
- `POST /api/tickets`: create arguments.
- `GET /api/tickets/:id`: control detail envelope.
- `POST /api/tickets/:id`: update fields; the path supplies ticket_id.
- `POST /api/tickets/:id/comments`: `{ "body": "..." }`.

HTTP mutations return the normal control execute envelope; `ok: false` carries
a structured error even when transport succeeds. The shared daemon client has
`listTickets` (all pages), `readTicket`, `createTicket`, `updateTicket` and
`commentTicket` helpers. Desktop HTTP and agent MCP share the control service.

Encrypted RPCs `tickets.list` and `ticket.get` are registered and marked
read-only; their params match control get, without resource. Existing
`control.get`/`control.execute` also support tickets. Mobile and remote board
interfaces, native Mac/iOS boards, and cross-computer aggregation are deferred.

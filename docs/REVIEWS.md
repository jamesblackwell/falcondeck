# Review inbox

Executive bots (and any agent) send James things to decide on: mock-ups,
screenshots, reports, packets. A **review** is one decision with its evidence, a
recommendation, and a place for per-item feedback, answerable from a phone. It
is a shared object shaped like [tickets](TICKETS.md) and entirely separate from
them and from conversation history, so it can be removed cleanly: delete
`control/reviews.rs`, `app/reviews.rs`, `core/src/reviews.rs`,
`client-core/src/reviews.ts` and the clients' Reviews views.

Switch: **Settings → General → Review inbox** (`review_inbox_enabled`, default
on). Off hides the UI everywhere, and `review.create` stores nothing and returns
the same content as a plain Markdown `message` for the agent to send James in
its reply (`delivered_as: "message"`). Existing reviews stay on disk.

## Record

`Review` (`falcondeck-core/src/reviews.rs`, `client-core/src/reviews.ts`): `id`
(`R-12`), `title`, `ask` (one line), `recommendation` (required), optional
`going_ahead_at`, Markdown `body`, `status` (`open`, `approved`,
`changes_requested`, `rejected`, `withdrawn`), `items`, `source_thread_id`,
`source_workspace_id`, `bot`, `created_by`, `created_at`, `updated_at`, `folder`,
`responded_at`, `overall_decision`, `overall_note`, `delivery`.

An **item** has `id` (`i1`…), `title`, `note`, `evidence`, and James's `decision`
(`approve`, `request_changes`, `reject`) and `feedback`. **Evidence** is a file
(`kind: "file"`), an image (`"image"`) or a URL; the daemon infers the kind. A
file has `open_path` (read it with `file.stat`/`file.read_range`; see
[FILE-PREVIEW](FILE-PREVIEW.md)), `original_path`, `snapshotted`, `content_type`
and `size_bytes`.

`going_ahead_at` is display only ("going ahead at 17:00 unless you say no"). The
daemon does not act on it; the agent proceeds by itself.

Status after a response: any item with changes requested gives
`changes_requested`; else any rejection gives `rejected`; else `approved`.

## Evidence snapshots

At publish time each path evidence is checked with the same access policy phones
use, then files up to 8 MiB are copied (up to 48 MiB per review) into
`<state dir>/reviews/<id>/evidence/`. `open_path` points at the copy, so what
James approves cannot change underneath him. Larger files stay references
(`snapshotted: false`). A denied, missing or out-of-policy path fails the whole
`review.create` with the reason, so an agent cannot publish `~/.ssh/id_rsa`.
`reviews` is in the file-preview allow-list. Only the single file is copied: tell
agents to attach self-contained PNG/PDF/Markdown/single-file HTML.

Storage: `<state dir>/reviews/reviews.json` (versioned, atomic writes, fail
closed on a bad or future file), written only by the daemon.

## Agent tools

Through the control MCP (`falcondeck_search` then `falcondeck_execute`), reads via
`falcondeck_get` resources `reviews` (open by default; `status`, `bot`,
`include_closed`) and `review` (`id`).

- `review.create`: `title`, `ask`, `recommendation` (all required), `items` (1-12,
  each `title`, `note`, `evidence[]` of `{path|url, title?, caption?}`), `body`,
  `going_ahead_at`. One decision per review. Source thread and bot come from the
  call context, never arguments. An agent may have five open reviews.
- `review.update`: own open review only; scalar fields plus `add_items`.
- `review.withdraw`: own open review, optional `reason`.
- `review.respond`: **James only.** Enforced by origin (desktop UI or paired
  device); agents get `review_forbidden`. This is a FalconDeck capability check,
  not an OS sandbox, like the ticket limit.

## What the agent receives

James's response is sent to the source thread as an ordinary user message with
`steer: true`: a running turn is steered, an idle thread starts one. For a bot the
message goes to the bot's current home (even after a harness switch). Feedback is
quoted verbatim.

```
[FalconDeck review response] James responded to your review R-12 "Pricing page".
Ask: Ship the new hero?
Result: Changes requested
Whole-review decision: Approved          (only when he gave one)

Item 1 of 3: Hero
Decision: Approved

Item 2 of 3: Pricing table
Decision: Changes requested
Feedback:
> Make the annual toggle default.
>
> Keep the Pro badge.

Note from James on the whole review:     (only when he wrote one)
> Otherwise good.

This review is closed. Act on the decisions above; publish a new review if you need another decision.
```

`delivery` on the review records `{state: "delivered"}` or `{state: "failed",
error}` (the source thread is gone); the response itself is always kept.

## Clients

- HTTP: `GET /api/reviews`, `GET /api/reviews/:id`, `POST /api/reviews/:id/respond`,
  `POST /api/reviews/:id/withdraw` (control envelope, like tickets).
- Remote RPC (read-only unless noted): `reviews.list`, `review.get`,
  `review.respond` (mutating; origin is fixed to the paired device).
- `control-state-changed` with domain `reviews` tells open views to refetch.
- Desktop only: `POST /api/files/stat` and `/api/files/read` (whole file, same
  policy) back the in-app preview.
- Push: a new review sends kind `review` ("Juno needs a decision: …"). Respects
  the "needs input" notification setting. Needs the relay deployed for the exact
  text; an older relay shows its generic "needs your attention".
- [Notification centre](NOTIFICATION-CENTRE.md): every review is recorded there
  even when the push is suppressed, and answering or withdrawing it resolves the
  record.

## Steering agents

`BOT_DEFAULT_INSTRUCTIONS` has one line under "Reviews", and the `review.create`
description says to use it instead of sending links. Standing instructions are
James's to edit. A review asks for a decision; for news that needs none, agents
use `falcondeck_notify` (see [NOTIFICATION-CENTRE](NOTIFICATION-CENTRE.md)).

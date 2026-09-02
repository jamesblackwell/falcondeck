---
name: falcondeck-missions
description: Create and update durable FalconDeck Missions. Use when the user explicitly asks to start or create a Mission, or when the current task is linked to one.
---

# FalconDeck Missions

A Mission is a durable project brief above ordinary agent tasks. It is not a
synonym for a difficult task, a harness goal, a permanent coordinator thread,
or an agent process that must keep running.

## Create

When the user explicitly requests a Mission:

1. Call `falcondeck_missions-create_mission` before doing the requested work.
2. Supply a concise title, the durable brief, and concrete success criteria.
   Treat the agreed definition as final for creation.
3. Include `deadline` only when the user requests or agrees to one. Missions
   have no default lifespan, worker count, or automatic-turn limit.
4. Choose the least-frequent `checkInDays` cadence that can still make useful
   progress. Ask the user only when that choice materially affects cost or
   timing. The first check-in runs immediately regardless of cadence.
5. Report that the Mission started and its first agent check-in is queued. Do
   not ask the user to activate or approve it again.
6. Do not silently substitute a native harness goal. A linked task may use its
   own Goal for focused work inside the Mission.

## Work

When this task is linked to a Mission:

- call `falcondeck_missions-read_mission` before material work when the durable
  brief or latest decisions are not already clear;
- use native Goals for focused execution inside this task when useful;
- use `falcondeck_missions-update_mission` only for meaningful progress,
  evidence, questions, decisions, task links, or status changes;
- supply the fields required by the selected update operation:
  `add_update` needs `kind` and `body`, `set_status` needs `status`,
  and `link_thread` needs `threadId`;
- after a failed Mission call or a human action, read the Mission again before
  retrying. Do not repeat an edit against stale status;
- prefer an existing linked task and create another only for clean context, a
  distinct harness/capability, independent work, or independent review;
- mark the Mission `waiting` instead of consuming tokens while nothing can
  change;
- mark it `needs_human` with a concrete question when authority or judgment is
  required;
- mark it `review` with evidence when the criteria appear satisfied; and
- never mark it complete or cancelled. Those are human decisions.

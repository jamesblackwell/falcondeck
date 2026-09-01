---
name: falcondeck-missions
description: Start and coordinate FalconDeck Missions. Use when the user explicitly asks to start, create, or run a Mission, or when FalconDeck identifies the current task as a Mission coordinator.
---

# FalconDeck Missions

Treat a FalconDeck Mission as an explicit coordination mode, not a synonym for
a difficult task or a harness goal.

## Start

When the user explicitly requests a Mission:

1. Call `falcondeck_missions-draft_mission` before doing the requested work.
2. Put the full outcome in `objective` and extract concrete acceptance criteria
   when the prompt supplies them. Do not invent requirements.
3. Put agreed limits in the structured `leaseMinutes`, `maxAutomaticTurns`, and
   `maxWorkers` fields. Do not leave limits only in objective prose. If the
   user did not specify them, omit them so FalconDeck applies its reviewed
   defaults (three hours, 12 turns, three workers).
4. Report that the draft awaits human review and start. Supported clients show
   those controls in this conversation; the Missions panel remains available.
5. Do not begin the task as an ordinary turn and do not create a harness goal
   instead.

## Coordinate

When FalconDeck starts or continues this task as a Mission coordinator:

- Follow the coordinator prompt and the Mission's hard limits.
- Use `falcondeck_missions-mission_status` when durable state is unclear.
- Delegate only genuinely independent work with
  `falcondeck_missions-mission_delegate`; do not spawn workers merely to extend
  the Mission.
- Call `falcondeck_missions-mission_checkpoint` exactly once before the turn
  ends. A prose claim does not complete the Mission; completion requires
  evidence and human acceptance.
- Work around ordinary technical blocks within the Mission's authority and
  limits. Pause for the human when intent, permission, safety, or external
  authority is missing.

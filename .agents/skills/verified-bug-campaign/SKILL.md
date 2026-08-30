---
name: verified-bug-campaign
description: Run an explicitly requested long-running campaign to find and fix verified bugs across client and backend code, with regression evidence and Autoreview on every commit. Not for one-off debugging.
---

# Verified Bug Campaign

Use only when the user explicitly asks to start or continue a broad bug-fixing
campaign. Explaining or editing the campaign does not authorize starting it.

## Campaign

1. Read `AGENTS.md`, repository documentation, manifests, tests, and existing
   working-tree changes.
2. Read [references/verification.md](references/verification.md).
3. Use the requested target, defaulting to 100, and create a durable goal with
   this skill's verification rules and stopping conditions.
4. Inventory every executable client, backend service, worker, integration, and
   shared runtime package. Track each as `NOT STARTED`, `IN PROGRESS`,
   `EXHAUSTED`, or `BLOCKED`.
5. Work systematically through the inventory, completing one verified defect at
   a time: reproduce, fix the root cause, add regression proof, run relevant
   checks, commit, then run the installed `autoreview` skill against that commit.
6. Independently verify and address accepted review findings. Count the bug only
   after its final proof, tests, commit, and Autoreview pass.
7. Run broader tests after each subsystem and before completion.

Maintain this ledger in goal progress, not the repository:

`ID | Area | Trigger | Pre-fix proof | Post-fix proof | Commit | Autoreview`

Follow repository commit conventions. Preserve unrelated changes. Do not create
branches or pull requests unless requested.

## Stop

Stop when the target is reached, every mapped area is exhausted, the user pauses
the goal, or missing access or product intent prevents further verification.

The target is an aim. Never manufacture weak findings to reach it.


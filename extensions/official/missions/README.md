# Missions

Missions is FalconDeck's bundled, disabled-by-default reference extension for
bounded long-running coordination. V1 adopts one existing Claude task,
keeps the conversation in the underlying harness, and asks the daemon's public
orchestration facet to admit at most four automatic turns within an initial
30-minute lease.

The extension owns the objective, criteria, checkpoint, progress fingerprint,
and completion proposal. The daemon owns the durable journal, task binding,
permission checks, deadlines, admission count, restart handling, and provider
dispatch. Completion is never inferred from an agent reply: the human accepts
it in the Missions panel.

V1 intentionally has no worker tasks or native harness delegation. Codex and
OpenCode task-bound tools remain ineligible until their workspace-wide bridge
can authenticate an exact task and turn.

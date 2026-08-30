# Missions

Missions is FalconDeck's bundled, disabled-by-default reference extension for
bounded long-running coordination. The current slice adopts one existing
Claude or Codex task,
keeps the conversation in the underlying harness, and asks the daemon's public
orchestration facet to admit at most four automatic turns within an initial
30-minute lease. A coordinator may allocate at most three one-turn Codex
workers. Workers are visible ordinary tasks and run serially so same-folder
writers never overlap.

The extension owns the objective, criteria, checkpoint, progress fingerprint,
and completion proposal. The daemon owns the durable journal, task binding,
permission checks, deadlines, admission count, restart handling, and provider
dispatch. Completion is never inferred from an agent reply: the human accepts
it in the Missions panel.

Claude uses its task-bound per-turn bridge. Codex uses its workspace bridge
only when the daemon can prove there is exactly one running Codex task in that
workspace; ambiguous calls fail closed. FalconDeck refreshes idle Codex
app-server sessions when agent tools are first enabled so existing tasks can
receive the bridge on their next turn. OpenCode coordinators remain ineligible
until its bridge can provide the same unambiguous identity and reliable turn
receipts.

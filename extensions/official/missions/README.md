# Missions

Missions is FalconDeck's bundled, disabled-by-default reference extension for
bounded long-running coordination. The current slice adopts one existing
Claude or Codex task,
keeps the conversation in the underlying harness, and asks the daemon's public
orchestration facet to enforce a human-reviewed lease (three hours by default,
up to 24 hours), coordinator-turn budget (12 by default, up to 24), and worker
budget (three by default, up to four). Workers are visible ordinary tasks and
run serially so same-folder writers never overlap. After the human starts a
Mission, its coordinator and worker turns use an explicit autonomous profile:
Codex runs with never-ask/full access and Claude runs with bypass permissions.
The approval UI states this before start; ordinary non-Mission tasks keep their
own selected permission posture.

The extension owns the objective, criteria, checkpoint, progress fingerprint,
and completion proposal. The daemon owns the durable journal, task binding,
permission checks, deadlines, admission count, restart handling, and provider
dispatch. Completion is never inferred from an agent reply: the human accepts
it in the Missions panel.

After the agent drafts a Mission, supported clients render the extension's
Review/edit and Start controls in the same conversation. Starting remains a
human action; clients without the trusted frontend keep the ordinary tool
result and the Missions dashboard remains available.

Desktop and remote web render a trusted Missions dashboard. Before the three
permissions are granted it shows a setup checklist and links to Extension
settings; it does not offer an action that is guaranteed to fail. After setup,
the same panel shows bounded run state, human controls, pending drafts, and
eligible coordinator tasks. Mobile keeps the attributed unsupported fallback
for trusted extension frontends.

Claude uses its task-bound per-turn bridge. Codex uses its workspace bridge
only when the daemon can prove there is exactly one running Codex task in that
workspace; ambiguous calls fail closed. FalconDeck refreshes idle Codex
app-server sessions when agent tools are first enabled so existing tasks can
receive the bridge on their next turn. OpenCode coordinators remain ineligible
until its bridge can provide the same unambiguous identity and reliable turn
receipts.

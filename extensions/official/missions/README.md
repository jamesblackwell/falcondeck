# Missions

Missions is FalconDeck's bundled, disabled-by-default project layer for work
that may span several native agent tasks and long periods of waiting.

A Mission stores a brief, success criteria, status, updates, and links to the
ordinary tasks doing the work. It does not own transcripts, keep one permanent
coordinator alive, impose a default deadline, or replace harness-native Goals.
Agents can start a Mission from any eligible task, read linked Mission state,
post evidence/questions/progress, change non-terminal status, and link other
existing tasks. A human completes or cancels the Mission.

Desktop and remote web render the trusted Missions dashboard and the inline
started result. Mobile and older clients retain the attributed generic tool
result fallback. The extension requires `threads:read`,
`agent-tools:register`, and `automations:manage-owned`, all denied by default.

Starting creates an extension-owned Automation in FalconDeck's existing Agent
Control scheduler and queues its first run immediately, using the source task's
workspace, provider, model, and authority settings. Each check-in starts or
reuses an ordinary native task, which receives verified Mission provenance and
reads the durable brief before working. Pausing or closing the Mission pauses
future reviews; there is no Mission-specific agent loop or default lifespan.
See `docs/MISSIONS.md`.

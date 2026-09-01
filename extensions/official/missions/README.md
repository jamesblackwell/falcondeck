# Missions

Missions is FalconDeck's bundled, disabled-by-default project layer for work
that may span several native agent tasks and long periods of waiting.

A Mission stores a brief, success criteria, status, updates, and links to the
ordinary tasks doing the work. It does not own transcripts, keep one permanent
coordinator alive, impose a default deadline, or replace harness-native Goals.
Agents can create a draft from any eligible task, read linked Mission state,
post evidence/questions/progress, change non-terminal status, and link other
existing tasks. A human activates, completes, or cancels the Mission.

Desktop and remote web render the trusted Missions dashboard and the inline
draft result. Mobile and older clients retain the attributed generic tool
result fallback. The extension currently requires `threads:read` and
`agent-tools:register`, both denied by default.

The next slice adds extension-owned Automations through the existing Agent
Control scheduler. It will let a Mission wake an agent after days or months
without adding a Mission-specific agent loop. See `docs/MISSIONS.md`.

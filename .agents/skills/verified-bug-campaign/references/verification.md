# Bug Verification Protocol

A candidate is verified only when:

1. Expected behavior is established by a contract, test, call site, documented
   behavior, or unambiguous invariant.
2. The unmodified code reproducibly violates that behavior.
3. The trigger and impact are recorded.
4. A root-cause fix is implemented.
5. The same reproduction passes after the fix.
6. Relevant regression checks pass.
7. The final commit completes Autoreview.

Prefer a failing-then-passing unit or integration test. Browser QA is acceptable
for rendered client behavior when it records the route, state or fixture,
viewport, actions, expected result, pre-fix result, and post-fix evidence.

Do not count speculative risks, style or coverage concerns, duplicate symptoms
of one defect, refactors without incorrect behavior, or candidates that cannot
be proven by tests or browser QA.

Run Autoreview in commit mode against every created or amended commit. Treat its
findings as advisory and verify each one before changing code. If an accepted
finding changes the commit, rerun the relevant tests and Autoreview.

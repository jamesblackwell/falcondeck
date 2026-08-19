---
name: fresh-eyes-review
description: Reread recent code, catch obvious bugs/smells, and make focused cleanup fixes before handoff.
---

# Fresh Eyes Review

Use this skill after an implementation pass when the user asks for a careful second look at the code that was just written or modified.

## Scope

- Focus on code changed in the current session or current working-tree diff.
- Include nearby existing code when it is needed to understand behavior or spot integration mistakes.
- Do not broaden into a full repository audit unless the user explicitly asks.
- Ignore unrelated dirty files from other users or agents.

## Review Pass

Read the changed code as if you did not write it. Look specifically for:

- Obvious bugs, broken assumptions, edge cases, and off-by-one or null/undefined issues.
- Confusing names, awkward control flow, duplicate logic, and unnecessary abstractions.
- Behavior that conflicts with nearby project conventions.
- Missing or weak validation, error handling, loading states, authorization checks, or cleanup.
- Tests that no longer match behavior, or important changed behavior with no focused test.
- Dead code, stale comments, misleading comments, and debug leftovers.

## Fix Pass

- Make small, behavior-preserving refactors when they clearly improve clarity.
- Fix concrete bugs and inconsistencies found during the review.
- Prefer existing project patterns over introducing new structures.
- Keep changes tightly scoped to the reviewed code.
- Avoid churn that only changes style without improving correctness or readability.

## Verification

- Run the smallest relevant test, typecheck, lint, or formatter command that validates the touched code.
- If verification is impractical, explain what was not run and why.
- In the final response, summarize only meaningful fixes and remaining risks.

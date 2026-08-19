---
name: just-say-no-to-process-porn
description: "Keep agents focused on requested code and tests. Use when work drifts into unnecessary audits, ceremonies, gates, or process."
---

# Just Say No to Process Porn

## Mission

Maximize useful progress toward the requested outcome. Prefer working code, focused tests, and clear blockers over activity that only looks like progress.

## Detect the process loop

Treat the work as process porn when one or more of these patterns appear:

- Produce status reports instead of changing the relevant code.
- Create gates, receipts, manifests, hashes, evidence bundles, or certification records that were not requested.
- Repeat repository exploration after the relevant code path is known.
- Design elaborate recovery procedures for a normal implementation task.
- Build infrastructure to prove that work might be safe instead of performing a safe, scoped change.
- Write a long plan for a small, reversible fix.
- Ask for authorization for routine, in-scope work.
- Spend more time describing work than doing it.
- Continue a process after it has produced no useful artifact or decision.

Do not classify a plan, test, backup, review, or approval as process porn when project policy, risk, or the user requires it.

## Interrupt protocol

When the loop is detected:

1. Say plainly: “I am in a process loop.”
2. Name the requested outcome in one sentence.
3. Stop creating process artifacts.
4. Identify the highest-impact unresolved implementation or bug.
5. Inspect only the files, callers, and tests needed for that task.
6. Implement the smallest correct change.
7. Run the narrowest useful verification.
8. Report the change, verification, and remaining risk.

Use this compact reset message, then act immediately:

```text
Process loop detected: [what became ceremonial].
Real task: [the requested outcome].
Next action: [the concrete code or test action].
```

## Preserve legitimate safeguards

Do not use this skill to bypass:

- Security, privacy, authentication, or billing controls
- Required migrations or data-integrity checks
- Destructive-action confirmation
- Explicit user approval boundaries
- Repository instructions
- Focused tests needed to verify the change
- Deployment, release, or compliance requirements that genuinely apply

When a safeguard is required, perform it briefly and explain its purpose. Do not multiply safeguards without a concrete risk.

## Match process to risk

Use minimal process for small, reversible fixes, local refactors, straightforward UI changes, focused test repairs, and known implementation tasks.

Use more process for public APIs, schema or data migrations, billing and credits, authentication and authorization, privacy or safety-sensitive behavior, destructive operations, production deployments, and ambiguous or high-impact changes.

Match the amount of process to the risk.

## Prefer evidence over ceremony

Treat these as strong evidence:

- A changed implementation
- A focused regression test
- A reproduced bug
- A passing type check or linter
- A verified API response
- A clear, reviewable diff

Treat these as weak evidence:

- A status report with no code change
- A gate that only confirms another gate
- An unrelated hash or receipt
- A large unused artifact collection
- A claim of completion without behavioral verification

## Response style

Be direct and compact. Prefer:

```text
Implemented [change].
Added or updated [verification].
Verified with: [command].
Remaining risk: [briefly state it, or say none known].
```

Avoid ceremony-heavy status updates, repeated declarations of intent, invented milestones, and reports that substitute for implementation.

Stop using this skill once work has returned to concrete implementation, debugging, testing, or a clearly stated blocker.

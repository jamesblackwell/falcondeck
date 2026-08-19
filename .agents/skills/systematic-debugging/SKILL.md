---
name: systematic-debugging
description: Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes.
---

# Systematic Debugging

Find the root cause before changing code. Do not patch symptoms.

## Core Rule

No fixes without root cause evidence first.

Use this skill for test failures, production bugs, build failures, performance problems, integration issues, and any behavior you cannot explain.

## Workflow

1. Read the error carefully.
   - Capture the exact message, stack trace, file, line, route, status, or failing assertion.
   - Do not skip warnings that appear near the failure.
2. Reproduce the issue.
   - Record exact steps or the exact command.
   - If it is flaky, collect more data before guessing.
3. Check recent changes.
   - Review the diff, recent commits, config changes, dependency changes, and environment differences.
4. Trace the failing data or control flow.
   - Find where the bad value, state, request, or assumption first appears.
   - In multi-component systems, add temporary diagnostics at each boundary.
   - For deep call stacks, read `references/root-cause-tracing.md`.
5. Compare with a working pattern.
   - Find similar working code in the repo.
   - List the meaningful differences before editing.
6. State one hypothesis.
   - Write the root cause as: "I think X fails because Y."
   - Test one variable at a time.
7. Add the smallest proof.
   - Prefer a failing test, focused repro command, log probe, or trace query.
8. Fix the source.
   - Make the smallest change that addresses the root cause.
   - Verify the original repro and a scoped regression check.

## Stop Conditions

Stop and return to investigation if you catch yourself:

- trying a quick fix before tracing the cause
- bundling multiple unrelated changes
- explaining behavior without evidence
- adapting a pattern you have not read
- saying "probably" when a command, log, or test could verify it

If three fix attempts fail, question the architecture before attempting a fourth. Surface what each failed attempt proved and ask whether the underlying pattern is wrong.

## Related Skills

Use these only when the current evidence calls for them:

- `sentry`: when production exceptions, stack traces, releases, or event
  fingerprints are part of the failure.
- `grafana-observability`: when the bug depends on API, queue, generation, LLM,
  deploy, trace, metric, or infrastructure behavior.
- `db-query`: when the hypothesis depends on production database state and a
  read-only replica query is appropriate.
- `local-api-testing`: when a Laravel endpoint, job, database fixture, or API
  contract needs a local repro.
- `automated-qa-testing`: when the bug is only visible through browser UI,
  navigation, auth/session state, or rendered interaction.

## References

- `references/full-process.md`: expanded debugging process and red flags.
- `references/root-cause-tracing.md`: backward tracing through call stacks and data flow.
- `references/defense-in-depth.md`: validation after the source cause is known.
- `references/condition-based-waiting.md`: replace arbitrary sleeps with condition polling.
- `scripts/find-polluter.sh`: helper for isolating test pollution.

# Automation precheck review receipt

Date: 2026-11-02. Branch: `feat/automation-precheck`. Base: `50c1db24`.

## Claude review

Repo-local Autoreview, Claude `claude-fable-5`, thinking `high`, threshold
P0/P1. Exit 0: **no accepted/actionable findings**. The final reviewed code
includes rejection of per-command trust approval policies and validation of
inherited approval settings on reused threads.

```sh
.agents/skills/autoreview/scripts/autoreview --mode local \
  --engine claude --thinking high --max-priority P1 \
  --prompt 'Review P0/P1 automation/control-plane correctness and security. command/exec uses the installed Codex argv/cwd/sandboxPolicy/timeoutMs/outputBytesCap/processId API without thread/turn creation; terminate accepts processId. This revision rejects per-command trust-approval policies because command/exec has no approval channel, including inherited approval on reused threads. Other harnesses and isolated/cloud execution fail closed. Verify no-inference no-op, rate-limited durable failure dispatch, permissions, bounded storage, history and health.' \
  --output /tmp/precheck-approved-review.md \
  --json-output /tmp/precheck-approved-review.json
```

The [structured reviewer result](automation-precheck-2026-11-02.json) is
preserved alongside this receipt. No P0/P1 findings remain.

## Validation

The full Rust suite runs serially because the existing workspace-restore
and legacy lock tests are timing-sensitive under parallel execution. The
core round-trip fixture was updated to include the already-serialized
`only_when_changed: false` default.

For integration-test isolation, a process-local macOS sandbox denies reads from the user's
native transcript directories (`.codex/sessions`, `.codex/archived_sessions`,
`.claude/projects`, `.grok/sessions`). This prevents embedded test daemons
from indexing personal history. It changes no user settings or stored state.
The existing shared Cargo target directory was reused.

```sh
cargo test -p falcondeck-core --locked
cargo test -p falcondeck-daemon --lib --locked -- --test-threads=1
sandbox-exec -f /tmp/precheck-tests.sb cargo test -p falcondeck-daemon \
  --test acp_conformance --test control_api --test control_mcp \
  --test control_scheduler --test http_api --test startup_resume \
  --test terminal_api --test unreal_agent_acp --test workspace_reconnect \
  --locked -- --test-threads=1
cargo test -p falcondeck-core -p falcondeck-daemon --doc --locked
npm run typecheck --workspace @falcondeck/client-core
npm run test --workspace @falcondeck/client-core
```

The sandbox profile is `(version 1) (allow default)` followed by a
`deny file-read*` rule with the four absolute native transcript subpaths above.
Unit tests run outside that sandbox because macOS restricts the process-command
inspection used by an unrelated orphan-registry unit test inside a sandbox.
All normal crate test targets are included; no test-name filters are used.
All commands passed. Results:

| Scope | Passed | Existing ignores |
| --- | ---: | ---: |
| Core unit and integration tests | 111 | 0 |
| Daemon unit tests | 1,646 | 7 |
| All nine daemon integration targets | 57 | 1 |
| Shared client tests (78 files) | 790 | 0 |

Both Rust doc-test targets passed (zero examples). Shared client typecheck and
`git diff --check` passed. The ignored tests are existing subprocess helpers or
explicit performance measurements; no new ignore or test-name skip was added.

The new regression coverage exercises exit-0 suppression with null thread and
usage, fire-code dispatch with literal argv and untrusted evidence, unexpected
exit/timeout failure throttling, durable atomic cooldown across restart and
history pruning, create/update/null removal, invalid authority/cwd/timeout,
symlink escape, UTF-8 bounds and aggregate store size.

See [the design note](../AUTOMATION-PRECHECKS.md) for the execution contract and
provider limitations, and [the webhook proposal](../proposals/inbound-alert-webhook.md)
for the separate proposal-only alert ingress design. No application deployment,
installation, restart or merge was performed.

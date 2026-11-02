# Automation prechecks

An automation may run a deterministic command before starting a native thread
or an agent turn. This avoids inference on quiet schedules. The existing
create/update authority, revisions, concurrency policy, scheduler slots and
persistent control store apply to prechecks too.

```json
{
  "name": "Investigate new issues",
  "trigger": { "kind": "interval", "every_seconds": 1800, "anchor_at": "2026-11-02T00:00:00Z" },
  "task": { "kind": "prompt", "instruction": "Investigate the issues in the precheck evidence. Escalate only actionable issues." },
  "target": {
    "workspace_path": "/Users/james/Code/ops",
    "provider": "codex",
    "thread": { "kind": "new_each_run" },
    "sandbox_mode": "read-only",
    "isolation": "project_folder"
  },
  "precheck": {
    "argv": ["/usr/local/bin/check-issues", "--format", "text"],
    "cwd": "/Users/james/Code/ops",
    "timeout_seconds": 30,
    "fire_codes": [3]
  }
}
```

Supply this object as `automation.create` arguments. To replace the check,
pass `precheck` to `automation.update` with `automation_id` and the current
`expected_revision`. Omission preserves it; `precheck: null` removes it.
Timeout defaults to 60 seconds and must be 1–60. Fire codes default to `[3]`,
are nonempty, and exclude 0 and 124 (reserved for timeout).

- Exit 0 finishes as `skipped_unchanged`, with a no-action preview, no native
  thread, no turn and no inference. Existing dashboards already understand
  this status. This differs from `succeeded_no_action`, which required an agent.
- A fire code starts the normal turn. Bounded stdout/stderr and the exit code
  are appended as JSON evidence explicitly labelled untrusted data. Output
  cannot change the configured authority or become a control operation.
- Other exits, startup/API errors and timeouts produce a structured precheck
  error. The first failure reserves one escalation turn; further failures for
  the same automation within six hours finish as `failed` without a thread.
  Reservation is durable and atomic even with overlapping runs. A failed
  agent startup consumes the reservation, preventing a broken provider from
  creating a retry storm. Changing or removing the check does not reset it.

`automation.runs` includes each run's `precheck` evidence. Single automation
reads and `automation.health` expose the configuration and `last_precheck`,
including exit code, checked timestamp, stdout, stderr, error and whether the
failure reserved an escalation. Health also counts `precheck_failures` in the
selected period, including failures whose escalation turn succeeded. The last result and failure reservation live
on the definition, so pruning run history does not erase the cooldown.
Precheck-only runs contribute no agent time. A precheck takes precedence over
a bot's `only_when_changed`: external command findings must not be hidden by
an unchanged local digest. Resting bots and unavailable dependencies retain
the existing scheduler behavior.

## Execution and security boundary

Execution uses Codex app-server `command/exec`, which accepts an argv vector
and the same sandbox-policy object used by a turn. It creates no thread and
invokes no model. There is no daemon-host subprocess fallback and no implicit
shell. Environment computation belongs to the same provider runtime as the
automation; FalconDeck adds no environment overrides or extra credentials.
Do not embed secrets in argv or print secrets: configuration and bounded
output are visible to readers of the control surface.

The initial implementation accepts Codex targets with an explicit `read-only`,
`workspace-write` or `danger-full-access` sandbox mode and project-folder
isolation. Elevated modes still require the existing elevated-automation
setting. Approval policies that require per-command trust review (`untrusted`
and its aliases) are rejected, including inherited policy on a reused thread:
`command/exec` has no approval-request channel. Unknown policies also fail
closed. The default on-request policy remains sandbox-bound without escalation.
Claude and ACP have no equivalent standalone sandboxed execution
contract here, so they are rejected rather than running on the daemon's host
permissions. Reused isolated or cloud threads are rejected at execution as well.
Isolated-worktree targets are rejected because their writable
root does not exist until thread creation. Unsupported older app-servers fail
closed and use the normal failure escalation. Extending this to another
harness requires an equivalent sandboxed argv API, not a shell wrapper.

The cwd must resolve to a directory inside the workspace; symlink escapes are
rejected both at definition validation and immediately before execution.
The provider enforces a deadline of at most 60 seconds; the daemon also bounds
startup/execution and requests termination of only the command on timeout.
Capture is capped at 8 KiB per stream (16 KiB total), with an additional UTF-8
safe bound before persistence. Older stored output may be dropped under a
512 KiB aggregate evidence budget; `output_truncated` records truncation while
exit codes, errors, timestamps and cooldown reservations remain. A command may explicitly invoke an interpreter
as its executable, but FalconDeck never interprets metacharacters itself.

Prechecks have the authority already granted to unattended automation
commands. They cannot request sandbox escalation. Creation/update remain
behind the existing control enablement/provider/ownership checks; this adds
no separate unauthenticated execution endpoint or extension permission.

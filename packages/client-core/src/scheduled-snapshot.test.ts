import { describe, expect, it } from "vitest";

import { normalizeDaemonSnapshot } from "./normalization";
import { applySnapshotEvent } from "./snapshot";
import type { EventEnvelope, ScheduledTaskSummary } from "./types";

const task: ScheduledTaskSummary = {
  id: "scheduled-1",
  title: "Daily briefing",
  prompt_preview: "Prepare the briefing",
  status: "active",
  schedule: {
    kind: "recurring",
    rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
    timezone: "Europe/London",
  },
  workspace_id: "workspace-1",
  provider: "codex",
  next_run_at: "2026-08-14T08:00:00Z",
  last_run: null,
  updated_at: "2026-08-13T08:00:00Z",
};

function envelope(event: EventEnvelope["event"]): EventEnvelope {
  return {
    seq: 1,
    emitted_at: "2026-08-13T08:00:00Z",
    workspace_id: null,
    thread_id: null,
    event,
  };
}

describe("scheduled task snapshot events", () => {
  it("converges create, run, update, and delete events", () => {
    let snapshot = normalizeDaemonSnapshot({
      daemon: { version: "test", started_at: "2026-08-13T08:00:00Z" },
    });
    snapshot = applySnapshotEvent(
      snapshot,
      envelope({ type: "scheduled-task-created", task }),
    )!;
    expect(snapshot.scheduled_tasks).toEqual([task]);

    const run = {
      id: "run-1",
      task_id: task.id,
      status: "queued" as const,
      trigger: "scheduled" as const,
      scheduled_for: "2026-08-14T08:00:00Z",
      workspace_id: task.workspace_id,
    };
    snapshot = applySnapshotEvent(
      snapshot,
      envelope({ type: "scheduled-task-run-started", task_id: task.id, run }),
    )!;
    expect(snapshot.scheduled_tasks?.[0]?.last_run).toEqual(run);

    snapshot = applySnapshotEvent(
      snapshot,
      envelope({
        type: "scheduled-task-updated",
        task: { ...task, status: "paused", next_run_at: null },
      }),
    )!;
    expect(snapshot.scheduled_tasks?.[0]?.status).toBe("paused");

    snapshot = applySnapshotEvent(
      snapshot,
      envelope({ type: "scheduled-task-deleted", task_id: task.id }),
    )!;
    expect(snapshot.scheduled_tasks).toEqual([]);
  });

  it("ignores malformed definitions and mismatched run ownership", () => {
    const initial = normalizeDaemonSnapshot({
      daemon: { version: "test", started_at: "2026-08-13T08:00:00Z" },
      scheduled_tasks: [task],
    });
    const malformed = envelope({
      type: "scheduled-task-updated",
      task: {
        ...task,
        schedule: { kind: "recurring", timezone: "UTC" },
      } as ScheduledTaskSummary,
    });
    const afterMalformed = applySnapshotEvent(initial, malformed);
    expect(afterMalformed).toBe(initial);

    const mismatchedRun = envelope({
      type: "scheduled-task-run-updated",
      task_id: task.id,
      run: {
        id: "run-other",
        task_id: "scheduled-other",
        status: "succeeded",
        trigger: "manual",
        scheduled_for: "2026-08-13T09:00:00Z",
        workspace_id: task.workspace_id,
      },
    });
    expect(applySnapshotEvent(initial, mismatchedRun)).toBe(initial);
  });
});

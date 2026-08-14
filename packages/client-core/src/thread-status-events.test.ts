import { describe, expect, it } from "vitest";

import { normalizeDaemonSnapshot } from "./normalization";
import { applySnapshotEvent } from "./snapshot";
import type { EventEnvelope, ThreadSummary } from "./types";

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: "thread-1",
    workspace_id: "workspace-1",
    title: "Community",
    provider: "claude",
    status: "idle",
    updated_at: "2026-08-13T18:28:00Z",
    last_message_preview: null,
    latest_turn_id: null,
    latest_plan: null,
    latest_diff: null,
    last_tool: null,
    last_error: null,
    agent: {
      model_id: null,
      reasoning_effort: null,
      collaboration_mode_id: null,
      approval_policy: null,
      service_tier: null,
    },
    attention: {
      level: "none",
      badge_label: null,
      unread: false,
      pending_approval_count: 0,
      pending_question_count: 0,
      last_agent_activity_seq: 0,
      last_read_seq: 0,
    },
    is_archived: false,
    is_pinned: false,
    goal: null,
    queued_turns: [],
    variant: null,
    ...overrides,
  };
}

function envelope(event: EventEnvelope["event"]): EventEnvelope {
  return {
    seq: 1,
    emitted_at: "2026-08-13T18:28:15Z",
    workspace_id: "workspace-1",
    thread_id: "thread-1",
    event,
  };
}

function apply(snapshot: ReturnType<typeof normalizeDaemonSnapshot>, next: ThreadSummary) {
  return applySnapshotEvent(
    snapshot,
    envelope({ type: "thread-updated", thread: next }),
  )!;
}

describe("thread status events", () => {
  const running = thread({
    status: "running",
    updated_at: "2026-08-13T18:28:14Z",
  });
  const settled = thread({
    status: "idle",
    updated_at: "2026-08-13T18:28:15Z",
  });

  function snapshotWith(initial: ThreadSummary) {
    return normalizeDaemonSnapshot({
      daemon: { version: "test", started_at: "2026-08-13T08:00:00Z" },
      threads: [initial],
    });
  }

  it("keeps a stopped thread idle when a stale running update lands late", () => {
    let snapshot = snapshotWith(running);
    snapshot = apply(snapshot, settled);
    // Emitted by a background task that captured the summary before the turn
    // settled; without a guard it would spin the thread forever.
    snapshot = apply(snapshot, running);

    expect(snapshot.threads[0]?.status).toBe("idle");
  });

  it("still applies updates that preserve the thread's recency", () => {
    let snapshot = snapshotWith(settled);
    snapshot = apply(
      snapshot,
      thread({ ...settled, is_pinned: true, title: "Renamed" }),
    );

    expect(snapshot.threads[0]?.is_pinned).toBe(true);
    expect(snapshot.threads[0]?.title).toBe("Renamed");
  });

  it("keeps a settled thread settled when a stale running update ties on time", () => {
    let snapshot = snapshotWith(running);
    snapshot = apply(snapshot, settled);
    // Attention-only rebroadcasts (mark-read, streamed-item updates) preserve
    // the thread's recency, so a stale one carries the same timestamp as the
    // terminal update rather than an older one.
    snapshot = apply(snapshot, thread({ ...running, updated_at: settled.updated_at }));

    expect(snapshot.threads[0]?.status).toBe("idle");
  });

  it("lets an answered approval resume a waiting thread without a new timestamp", () => {
    const waiting = thread({
      status: "waiting_for_input",
      updated_at: "2026-08-13T18:28:15Z",
    });
    let snapshot = snapshotWith(waiting);
    snapshot = apply(snapshot, thread({ ...waiting, status: "running" }));

    expect(snapshot.threads[0]?.status).toBe("running");
  });

  it("applies a newer running update to an idle thread", () => {
    let snapshot = snapshotWith(settled);
    snapshot = apply(
      snapshot,
      thread({ status: "running", updated_at: "2026-08-13T18:29:00Z" }),
    );

    expect(snapshot.threads[0]?.status).toBe("running");
  });
});

import { describe, expect, it } from "vitest";

import {
  applyConversationEventToItems,
  applyConversationEventsToItems,
  deriveConversationPresentation,
  reuseConversationPresentation,
} from "./conversation";
import {
  normalizeDaemonSnapshot,
  normalizePreferences,
  normalizeThreadSummary,
} from "./normalization";
import { applySnapshotEvent } from "./snapshot";
import type { ConversationItem, EventEnvelope, ThreadSummary } from "./types";

const at = "2026-08-09T12:00:00Z";

function measure(run: () => void, iterations: number) {
  for (let index = 0; index < 3; index += 1) run();
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) run();
  return performance.now() - started;
}

function rawThread(index: number, status: ThreadSummary["status"] = "idle"): ThreadSummary {
  return {
    id: `thread-${index}`,
    workspace_id: "workspace-1",
    title: `Thread ${index}`,
    provider: "codex",
    status,
    updated_at: at,
    last_message_preview: "preview",
    latest_turn_id: null,
    latest_plan: null,
    latest_diff: null,
    last_tool: null,
    last_error: null,
    agent: {
      model_id: "gpt-5",
      reasoning_effort: "medium",
      collaboration_mode_id: null,
      approval_policy: "on-request",
      service_tier: null,
    },
    attention: {
      level: status === "running" ? "unread" : "none",
      badge_label: null,
      unread: status === "running",
      pending_approval_count: 0,
      pending_question_count: 0,
      background_task_count: 0,
      last_agent_activity_seq: 1,
      last_read_seq: status === "running" ? 0 : 1,
    },
    is_archived: false,
    is_pinned: false,
    is_pinned_in_project: false,
    goal: null,
    queued_turns: [],
    variant: null,
  } as ThreadSummary;
}

function snapshotEvent(snapshot: unknown, seq: number): EventEnvelope {
  return {
    seq,
    emitted_at: at,
    workspace_id: null,
    thread_id: null,
    event: { type: "snapshot", snapshot },
  } as EventEnvelope;
}

function threadEvent(thread: ThreadSummary, seq: number): EventEnvelope {
  return {
    seq,
    emitted_at: at,
    workspace_id: thread.workspace_id,
    thread_id: thread.id,
    event: { type: "thread-updated", thread },
  };
}

const THREAD_COUNT = 1_500;
const rawThreads = Array.from({ length: THREAD_COUNT }, (_, index) => rawThread(index));
const rawSnapshot = {
  daemon: {
    version: "test",
    started_at: at,
    capabilities: { scheduled_tasks: true, computer_use: false },
  },
  workspaces: [
    {
      id: "workspace-1",
      path: "/tmp/workspace",
      kind: "project",
      status: "connected",
      agents: [
        {
          provider: "codex",
          status: "ready",
          models: [],
        },
      ],
      skills: [],
      models: [],
      collaboration_modes: [],
      current_thread_id: "thread-0",
      connected_at: at,
      updated_at: at,
    },
  ],
  threads: rawThreads,
  interactive_requests: [],
  preferences: {},
  extensions: { catalog: [], views: [] },
};

describe("sync hot path correctness", () => {
  it("replaces state from a fresh snapshot and keeps a second snapshot authoritative", () => {
    const first = applySnapshotEvent(null, snapshotEvent(rawSnapshot, 1));
    expect(first?.threads).toHaveLength(THREAD_COUNT);
    expect(first?.threads[0]?.id).toBe("thread-0");
    expect(first?.threads[0]?.provider).toBe("codex");

    const replacement = {
      ...rawSnapshot,
      threads: [rawThread(THREAD_COUNT + 1)],
    };
    const next = applySnapshotEvent(first, snapshotEvent(replacement, 2));
    expect(next).not.toBe(first);
    expect(next?.threads.map((thread) => thread.id)).toEqual([
      `thread-${THREAD_COUNT + 1}`,
    ]);
    const once = normalizeDaemonSnapshot(rawSnapshot);
    expect(normalizeDaemonSnapshot(once)).toEqual(once);
    expect(normalizeDaemonSnapshot(JSON.parse(JSON.stringify(once)))).toEqual(once);
    const thread = normalizeThreadSummary(rawThread(3));
    expect(normalizeThreadSummary(thread)).toBe(thread);
    expect(normalizeThreadSummary(JSON.parse(JSON.stringify(thread)))).toEqual(thread);
  });

  it("keeps the thread array when a running turn only repeats attention", () => {
    const base = normalizeDaemonSnapshot({
      ...rawSnapshot,
      threads: [rawThread(0, "running"), ...rawThreads.slice(1)],
      sync_index: {
        token: "compact",
        counts: {
          "workspace-1": { total: THREAD_COUNT, running: 1, unread: 1, awaiting: 0 },
        },
        cursors: {},
        touched_threads: { "thread-0": true },
        touched_views: {},
        catalog_touched: false,
        extensions_loaded: false,
      },
    });
    const running = base.threads[0]!;
    const repeated = threadEvent(
      {
        ...running,
        attention: { ...running.attention, last_agent_activity_seq: 4 },
      },
      2,
    );
    const next = applySnapshotEvent(base, repeated);
    expect(next?.threads).toBe(base.threads);
    expect(next?.threads[0]).toBe(running);

    const renamed = threadEvent({ ...running, title: "Renamed" }, 3);
    const updated = applySnapshotEvent(base, renamed);
    expect(updated?.threads[0]?.title).toBe("Renamed");
    expect(updated?.threads[1]).toBe(base.threads[1]);
    expect(updated?.threads[THREAD_COUNT - 1]?.id).toBe(`thread-${THREAD_COUNT - 1}`);
  });

  it("coalesced text frames match one-event application", () => {
    const tail = "x".repeat(8_000);
    const items: ConversationItem[] = [
      {
        kind: "user_message",
        id: "user-0",
        text: "Prompt",
        attachments: [],
        created_at: at,
      },
      {
        kind: "assistant_message",
        id: "assistant-0",
        text: tail,
        lifecycle: "streaming",
        created_at: at,
      },
      {
        kind: "reasoning",
        id: "reason-0",
        summary: "think",
        content: "content",
        lifecycle: "streaming",
        created_at: at,
      },
    ];
    const bodies: EventEnvelope["event"][] = [
      ...Array.from({ length: 40 }, (_, index) => ({
        type: "text" as const,
        item_id: "assistant-0",
        delta: "ab",
        target: "assistant_text" as const,
        start_offset: tail.length + index * 2,
        end_offset: tail.length + index * 2 + 2,
      })),
      {
        type: "text",
        item_id: "assistant-0",
        delta: "ab",
        target: "assistant_text",
        start_offset: tail.length,
        end_offset: tail.length + 2,
      },
      {
        type: "text",
        item_id: "assistant-0",
        delta: "zz",
        target: "assistant_text",
        start_offset: tail.length + 80 + 5,
        end_offset: tail.length + 80 + 7,
      },
      {
        type: "text",
        item_id: "reason-0",
        delta: "cd",
        target: "reasoning_content",
        start_offset: "content".length,
        end_offset: "content".length + 2,
      },
    ];
    const events = bodies.map(
      (event, index): EventEnvelope => ({
        seq: index + 1,
        emitted_at: at,
        workspace_id: "workspace-1",
        thread_id: "thread-1",
        event,
      }),
    );
    let sequential = items;
    for (const event of events) {
      sequential = applyConversationEventToItems(sequential, event);
    }
    const batched = applyConversationEventsToItems(items, events);
    expect(batched).toEqual(sequential);
    expect(batched[0]).toBe(items[0]);
    expect(batched[1]).toMatchObject({
      text: `${tail}${"ab".repeat(40)}`,
      lifecycle: "streaming",
    });
    expect(batched[2]).toMatchObject({ content: "contentcd" });
  });
});

describe("sync hot path timing", () => {
  it("stays within the measured budget for snapshot apply, thread fanout, and streaming frames", () => {
    const preferences = normalizePreferences(null);
    const items: ConversationItem[] = Array.from({ length: 800 }, (_, index) =>
      index % 2 === 0
        ? {
            kind: "user_message" as const,
            id: `user-${index}`,
            text: `Prompt ${index} with a paragraph of ordinary user text and no harness markup.`,
            attachments: [],
            created_at: at,
          }
        : {
            kind: "assistant_message" as const,
            id: `assistant-${index}`,
            text:
              index === 799
                ? "R".repeat(24_000)
                : `Response ${index} is already complete.`,
            lifecycle: index === 799 ? ("streaming" as const) : ("complete" as const),
            created_at: at,
          },
    );
    const tail = items[items.length - 1]!;
    const tailText = tail.kind === "assistant_message" ? tail.text : "";
    let presentation = deriveConversationPresentation(items, preferences);
    let streamed = items;
    const base = normalizeDaemonSnapshot({
      ...rawSnapshot,
      threads: [rawThread(0, "running"), ...rawThreads.slice(1)],
      sync_index: {
        token: "compact",
        counts: {
          "workspace-1": { total: THREAD_COUNT, running: 1, unread: 1, awaiting: 0 },
        },
        cursors: {},
        touched_threads: { "thread-0": true },
        touched_views: {},
        catalog_touched: false,
        extensions_loaded: false,
      },
    });
    const running = base.threads[0]!;

    const snapshotMs = measure(() => {
      applySnapshotEvent(null, snapshotEvent(rawSnapshot, 1));
    }, 20);

    let cursor = base;
    const threadMs = measure(() => {
      for (let index = 0; index < 400; index += 1) {
        cursor = applySnapshotEvent(
          cursor,
          threadEvent(
            {
              ...running,
              attention: {
                ...running.attention,
                last_agent_activity_seq: 4 + index,
              },
            },
            index + 1,
          ),
        )!;
      }
    }, 8);

    const streamMs = measure(() => {
      let nextItems = items;
      let textLength = tailText.length;
      for (let frame = 0; frame < 12; frame += 1) {
        const events: EventEnvelope[] = Array.from({ length: 48 }, (_, index) => {
          const start = textLength + index * 2;
          return {
            seq: frame * 48 + index + 1,
            emitted_at: at,
            workspace_id: "workspace-1",
            thread_id: "thread-1",
            event: {
              type: "text",
              item_id: "assistant-799",
              delta: "yz",
              target: "assistant_text",
              start_offset: start,
              end_offset: start + 2,
            },
          };
        });
        nextItems = applyConversationEventsToItems(nextItems, events);
        textLength += 96;
        presentation = reuseConversationPresentation(
          presentation,
          deriveConversationPresentation(nextItems, preferences),
        );
        streamed = nextItems;
      }
    }, 6);

    const total = snapshotMs + threadMs + streamMs;
    console.log(
      JSON.stringify({
        snapshotMs: Number(snapshotMs.toFixed(1)),
        threadMs: Number(threadMs.toFixed(1)),
        streamMs: Number(streamMs.toFixed(1)),
        totalMs: Number(total.toFixed(1)),
      }),
    );

    expect(cursor.threads).toBe(base.threads);
    expect(presentation.history_blocks.length).toBeGreaterThan(700);
    const stable = presentation.history_blocks.find((block) => block.kind === "item");
    const again = deriveConversationPresentation(streamed, preferences);
    expect(again.history_blocks.find((block) => block.kind === "item")).toBe(stable);
    // Unoptimized baseline on this machine was ~105–111ms total and ~67–72ms
    // streaming (2 runs). Optimized streaming stayed under 21ms. The total
    // ceiling still fails that baseline; snapshot apply is not part of the win.
    expect(streamMs).toBeLessThan(40);
    expect(total).toBeLessThan(100);
  });
});

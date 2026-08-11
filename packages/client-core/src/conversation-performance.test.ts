import { describe, expect, it } from "vitest";

import {
  applyConversationEventsToItems,
  conversationRenderBlockType,
  deriveConversationPresentation,
  reuseConversationPresentation,
  reuseRetrySourcesByAssistantId,
} from "./conversation";
import { normalizePreferences } from "./normalization";
import type { ConversationItem, EventEnvelope } from "./types";

const at = "2026-08-09T12:00:00Z";

function longThread(length = 1_000): ConversationItem[] {
  return Array.from({ length }, (_, index) =>
    index % 2 === 0
      ? {
          kind: "user_message" as const,
          id: `user-${index}`,
          text: `Prompt ${index}`,
          attachments: [],
          created_at: at,
        }
      : {
          kind: "assistant_message" as const,
          id: `assistant-${index}`,
          text: `Response ${index}`,
          lifecycle: "complete" as const,
          created_at: at,
        },
  );
}

describe("conversation presentation reuse", () => {
  it("classifies heterogeneous virtualized rows by their rendered shape", () => {
    const preferences = normalizePreferences(null);
    const items: ConversationItem[] = [
      {
        kind: "assistant_message",
        id: "answer",
        text: "Done",
        lifecycle: "complete",
        created_at: at,
      },
      {
        kind: "reasoning",
        id: "thought",
        summary: null,
        content: "Checking",
        lifecycle: "complete",
        created_at: at,
      },
    ];
    const presentation = deriveConversationPresentation(items, preferences);

    expect(
      presentation.history_blocks.map(conversationRenderBlockType),
    ).toEqual(["assistant_message", "reasoning"]);
    expect(
      conversationRenderBlockType({
        kind: "tool_summary",
        id: "summary",
        items: [],
        summary: {
          family: "explore",
          count: 0,
          started_at: at,
          completed_at: at,
          title: "Inspected files",
          subtitle: null,
          labels: [],
          counts: {},
          summary_hint: null,
        },
        default_open: false,
        suppress_read_only_detail: false,
      }),
    ).toBe("tool_summary");
  });

  it("retains all 999 completed block identities when only the streaming tail changes", () => {
    const preferences = normalizePreferences(null);
    const items = longThread();
    const first = deriveConversationPresentation(items, preferences);
    const previousTail = items.at(-1)!;
    const nextItems = [
      ...items.slice(0, -1),
      {
        ...previousTail,
        text: `${previousTail.kind === "assistant_message" ? previousTail.text : ""} token`,
      },
    ] as ConversationItem[];
    const derived = deriveConversationPresentation(nextItems, preferences);
    const reused = reuseConversationPresentation(first, derived);

    expect(reused.history_blocks).toHaveLength(1_000);
    for (let index = 0; index < 999; index += 1) {
      expect(reused.history_blocks[index]).toBe(first.history_blocks[index]);
    }
    expect(reused.history_blocks[999]).not.toBe(first.history_blocks[999]);
  });

  it("reuses stable blocks by id when older history is prepended", () => {
    const preferences = normalizePreferences(null);
    const items = longThread(10);
    const first = deriveConversationPresentation(items, preferences);
    const older: ConversationItem = {
      kind: "assistant_message",
      id: "older",
      text: "Earlier history",
      lifecycle: "complete",
      created_at: at,
    };
    const derived = deriveConversationPresentation(
      [older, ...items],
      preferences,
    );
    const reused = reuseConversationPresentation(first, derived);

    expect(reused.history_blocks[0]?.id).toBe("assistant_message:older");
    for (let index = 0; index < first.history_blocks.length; index += 1) {
      expect(reused.history_blocks[index + 1]).toBe(
        first.history_blocks[index],
      );
    }
  });

  it("returns the previous presentation when nothing changed", () => {
    const preferences = normalizePreferences(null);
    const items = longThread(20);
    const first = deriveConversationPresentation(items, preferences);
    const second = deriveConversationPresentation(items, preferences);

    expect(reuseConversationPresentation(first, second)).toBe(first);
  });

  it("retains the retry lookup when only assistant stream content changes", () => {
    const source: Extract<ConversationItem, { kind: "user_message" }> = {
      kind: "user_message",
      id: "source",
      text: "Regenerate this",
      attachments: [],
      turn_id: "turn-1",
      previous_turn_id: null,
      created_at: at,
    };
    const assistant: Extract<ConversationItem, { kind: "assistant_message" }> =
      {
        kind: "assistant_message",
        id: "answer",
        text: "Partial",
        phase: "final_answer",
        lifecycle: "streaming",
        created_at: at,
      };
    const first = reuseRetrySourcesByAssistantId(null, [source, assistant]);
    const second = reuseRetrySourcesByAssistantId(first, [
      source,
      { ...assistant, text: "Partial response" },
    ]);

    expect(second).toBe(first);
    expect(second.get("answer")).toBe(source);
  });
});

describe("conversation streaming batches", () => {
  it("applies a token burst to a long thread while retaining untouched item identities", () => {
    const completeItems = longThread();
    const completeTail = completeItems.at(-1)!;
    const items = [
      ...completeItems.slice(0, -1),
      { ...completeTail, lifecycle: "streaming" as const },
    ] as ConversationItem[];
    const tail = items.at(-1)!;
    expect(tail.kind).toBe("assistant_message");
    const initialLength =
      tail.kind === "assistant_message" ? tail.text.length : 0;
    const events: EventEnvelope[] = Array.from({ length: 50 }, (_, index) => ({
      seq: index + 1,
      emitted_at: at,
      workspace_id: "workspace-1",
      thread_id: "thread-1",
      event: {
        type: "text",
        item_id: tail.id,
        delta: "x",
        target: "assistant_text",
        start_offset: initialLength + index,
        end_offset: initialLength + index + 1,
      },
    }));

    const next = applyConversationEventsToItems(items, events);

    expect(next).not.toBe(items);
    expect(next).toHaveLength(items.length);
    for (let index = 0; index < items.length - 1; index += 1) {
      expect(next[index]).toBe(items[index]);
    }
    expect(next.at(-1)).toMatchObject({
      text: `${tail.kind === "assistant_message" ? tail.text : ""}${"x".repeat(50)}`,
      lifecycle: "streaming",
    });
  });

  it("preserves identity when an entire frame is replayed", () => {
    const items = longThread(2);
    const tail = items.at(-1)!;
    expect(tail.kind).toBe("assistant_message");
    const text = tail.kind === "assistant_message" ? tail.text : "";
    const replay: EventEnvelope = {
      seq: 1,
      emitted_at: at,
      workspace_id: "workspace-1",
      thread_id: "thread-1",
      event: {
        type: "text",
        item_id: tail.id,
        delta: text.slice(-1),
        target: "assistant_text",
        start_offset: text.length - 1,
        end_offset: text.length,
      },
    };

    expect(applyConversationEventsToItems(items, [replay, replay])).toBe(items);
  });
});

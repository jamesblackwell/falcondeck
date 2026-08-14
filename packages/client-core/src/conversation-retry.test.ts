import { describe, expect, it } from "vitest";

import type { ConversationItem } from "./types";
import { retrySourcesByAssistantId } from "./conversation";

const at = "2026-08-09T12:00:00Z";

function user(
  id: string,
  turnId: string | null,
): Extract<ConversationItem, { kind: "user_message" }> {
  return {
    kind: "user_message",
    id,
    text: id,
    attachments: [],
    turn_id: turnId,
    previous_turn_id: null,
    created_at: at,
  };
}

function assistant(
  id: string,
  phase: "commentary" | "final_answer" | null = "final_answer",
): Extract<ConversationItem, { kind: "assistant_message" }> {
  return {
    kind: "assistant_message",
    id,
    text: id,
    phase,
    memory_citation: null,
    lifecycle: "complete",
    created_at: at,
  };
}

describe("retrySourcesByAssistantId", () => {
  it("associates final and legacy answers with the latest provider-backed user turn", () => {
    const first = user("user-1", "turn-1");
    const second = user("user-2", "turn-2");
    const sources = retrySourcesByAssistantId([
      first,
      assistant("progress", "commentary"),
      assistant("answer-1"),
      second,
      assistant("answer-2", null),
    ]);

    expect(sources.get("answer-1")).toBe(first);
    expect(sources.get("answer-2")).toBe(second);
    expect(sources.has("progress")).toBe(false);
  });

  it("clears the candidate for steering messages without a safe turn boundary", () => {
    const sources = retrySourcesByAssistantId([
      user("original", "turn-1"),
      user("steering", null),
      assistant("answer"),
    ]);

    expect(sources.has("answer")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";

import {
  deriveConversationPresentation,
  reuseConversationPresentation,
} from "./conversation";
import { normalizePreferences } from "./normalization";
import type { ConversationItem, FalconDeckPreferences } from "./types";

function reasoning(
  overrides: Partial<Extract<ConversationItem, { kind: "reasoning" }>> = {},
): Extract<ConversationItem, { kind: "reasoning" }> {
  return {
    kind: "reasoning",
    id: "thought-1",
    summary: null,
    content: "Looking things up",
    lifecycle: "streaming",
    duration_ms: null,
    created_at: "2026-08-20T12:00:00Z",
    ...overrides,
  };
}

function tool(
  overrides: Partial<Extract<ConversationItem, { kind: "tool_call" }>> = {},
): Extract<ConversationItem, { kind: "tool_call" }> {
  return {
    kind: "tool_call",
    id: "tool-1",
    title: "Web search",
    tool_kind: "search",
    status: "completed",
    output: "results",
    exit_code: null,
    display: {
      is_read_only: true,
      has_side_effect: false,
      is_error: false,
      lifecycle: "succeeded",
      artifact_kind: "command_output",
      activity_kind: "search",
      history_mode: "summary",
      summary_hint: "Web search",
    },
    detail: null,
    created_at: "2026-08-20T12:00:03Z",
    completed_at: "2026-08-20T12:00:05Z",
    ...overrides,
  };
}

function collapsedPreferences(): FalconDeckPreferences {
  const defaults = normalizePreferences(null);
  return {
    ...defaults,
    conversation: {
      ...defaults.conversation,
      tool_details_mode: "collapsed",
    },
  };
}

function reasoningBlockItem(
  block: ReturnType<typeof deriveConversationPresentation>["history_blocks"][number],
) {
  if (block.kind !== "item" || block.item.kind !== "reasoning") {
    throw new Error(`expected a reasoning item block, got ${block.kind}`);
  }
  return block.item;
}

describe("stale reasoning lifecycles settle once later items exist", () => {
  it("settles an earlier stuck-streaming thought while the turn is still live", () => {
    const presentation = deriveConversationPresentation(
      [reasoning(), tool(), tool({ id: "tool-2", completed_at: null, status: "running", display: { ...tool().display, lifecycle: "running" } })],
      collapsedPreferences(),
      { is_streaming: true },
    );

    const [thought, work] = presentation.history_blocks;
    expect(reasoningBlockItem(thought!).lifecycle).toBe("complete");
    expect(work).toMatchObject({ kind: "work_session", running: true });
  });

  it("estimates the settled thought's duration from the next item's start", () => {
    const presentation = deriveConversationPresentation(
      [reasoning(), tool()],
      collapsedPreferences(),
      { is_streaming: true },
    );

    // 12:00:00 → 12:00:03
    expect(reasoningBlockItem(presentation.history_blocks[0]!).duration_ms).toBe(
      3_000,
    );
  });

  it("keeps a provider-reported duration over the estimate", () => {
    const presentation = deriveConversationPresentation(
      [reasoning({ duration_ms: 1_234 }), tool()],
      collapsedPreferences(),
      { is_streaming: false },
    );

    expect(reasoningBlockItem(presentation.history_blocks[0]!).duration_ms).toBe(
      1_234,
    );
  });

  it("keeps the trailing thought of a live turn streaming", () => {
    const presentation = deriveConversationPresentation(
      [tool(), reasoning({ created_at: "2026-08-20T12:00:06Z" })],
      collapsedPreferences(),
      { is_streaming: true },
    );

    const last = presentation.history_blocks.at(-1)!;
    // The trailing thought rides inside the live work session.
    expect(last.kind).toBe("work_session");
    if (last.kind !== "work_session") throw new Error("unreachable");
    const buried = last.items.at(-1)!;
    if (buried.kind !== "reasoning") throw new Error("expected reasoning tail");
    expect(buried.lifecycle).toBe("streaming");
  });

  it("settles the trailing thought once the turn ends", () => {
    const presentation = deriveConversationPresentation(
      [reasoning()],
      collapsedPreferences(),
      { is_streaming: false },
    );

    expect(reasoningBlockItem(presentation.history_blocks[0]!).lifecycle).toBe(
      "complete",
    );
  });

  it("settles a stuck thought buried between tool calls in a work session", () => {
    const presentation = deriveConversationPresentation(
      [
        tool(),
        reasoning({ created_at: "2026-08-20T12:00:06Z" }),
        tool({ id: "tool-2", created_at: "2026-08-20T12:00:08Z" }),
      ],
      collapsedPreferences(),
      { is_streaming: true },
    );

    const session = presentation.history_blocks[0]!;
    expect(session.kind).toBe("work_session");
    if (session.kind !== "work_session") throw new Error("unreachable");
    const buried = session.items[1]!;
    if (buried.kind !== "reasoning") throw new Error("expected buried thought");
    expect(buried.lifecycle).toBe("complete");
  });

  it("also settles in the summarizing (non-collapsed) modes", () => {
    const presentation = deriveConversationPresentation(
      [
        reasoning(),
        {
          kind: "assistant_message",
          id: "answer",
          text: "Streaming answer",
          lifecycle: "streaming",
          created_at: "2026-08-20T12:00:04Z",
        },
      ],
      normalizePreferences(null),
      { is_streaming: true },
    );

    expect(reasoningBlockItem(presentation.history_blocks[0]!).lifecycle).toBe(
      "complete",
    );
  });

  it("keeps settled copies referentially stable across derivations", () => {
    const items: ConversationItem[] = [reasoning(), tool()];
    const preferences = collapsedPreferences();
    const first = deriveConversationPresentation(items, preferences, {
      is_streaming: true,
    });
    const second = deriveConversationPresentation(items, preferences, {
      is_streaming: true,
    });

    expect(reuseConversationPresentation(first, second)).toBe(first);
  });
});

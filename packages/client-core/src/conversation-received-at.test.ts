import { describe, expect, it } from "vitest";

import type { ConversationItem } from "./types";
import {
  latestVisibleAssistantMessageId,
  type ConversationRenderBlock,
} from "./conversation";

function itemBlock(item: ConversationItem): ConversationRenderBlock {
  return {
    kind: "item",
    id: `${item.kind}:${item.id}`,
    item,
    default_open: false,
    suppress_read_only_detail: false,
  };
}

function assistant(
  id: string,
  overrides: Partial<
    Extract<ConversationItem, { kind: "assistant_message" }>
  > = {},
): ConversationItem {
  return {
    kind: "assistant_message",
    id,
    text: `Answer ${id}`,
    lifecycle: "complete",
    created_at: "2026-03-16T11:00:00Z",
    ...overrides,
  };
}

describe("latestVisibleAssistantMessageId", () => {
  it("returns the last finished assistant reply", () => {
    expect(
      latestVisibleAssistantMessageId([
        itemBlock(assistant("a1")),
        itemBlock({
          kind: "user_message",
          id: "u2",
          text: "Follow up",
          attachments: [],
          created_at: "2026-03-16T11:30:00Z",
        }),
        itemBlock(assistant("a2")),
      ]),
    ).toBe("a2");
  });

  it("skips commentary and in-flight answers", () => {
    expect(
      latestVisibleAssistantMessageId([
        itemBlock(assistant("a1")),
        itemBlock(assistant("a2", { phase: "commentary" })),
        itemBlock(assistant("a3", { lifecycle: "streaming" })),
      ]),
    ).toBe("a1");
  });

  it("returns null when no finished assistant reply is visible", () => {
    expect(latestVisibleAssistantMessageId([])).toBeNull();
    expect(
      latestVisibleAssistantMessageId([
        itemBlock(assistant("a1", { lifecycle: "streaming" })),
      ]),
    ).toBeNull();
  });
});

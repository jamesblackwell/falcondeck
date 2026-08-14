import React from "react";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { renderedMessageIds } = vi.hoisted(() => ({
  renderedMessageIds: [] as string[],
}));

vi.mock("../../../../packages/chat-ui/src/components/message", () => ({
  AGENT_STATUS_ROW_CLASS: "agent-status-row",
  LiveActivityLane: () => null,
  MessageCard: ({ item }: { item: { id: string } }) => {
    renderedMessageIds.push(item.id);
    return <article>{item.id}</article>;
  },
  ToolSummaryCard: () => null,
  WorkSessionCard: () => null,
}));

import { Conversation } from "../../../../packages/chat-ui/src/components/conversation";

describe("Conversation render isolation", () => {
  beforeEach(() => {
    renderedMessageIds.length = 0;
  });

  it("reconciles only the changed tail row during a 1,000-message stream update", () => {
    const items = Array.from({ length: 1_000 }, (_, index) => ({
      kind: "assistant_message" as const,
      id: `assistant-${index}`,
      text: `Stable response ${index}`,
      lifecycle: index === 999 ? ("streaming" as const) : ("complete" as const),
      created_at: "2026-08-08T12:00:00Z",
    }));
    const { rerender } = render(
      <Conversation threadKey="long-thread" items={items} isThinking />,
    );

    expect(renderedMessageIds).toHaveLength(1_000);
    renderedMessageIds.length = 0;

    const nextItems = [
      ...items.slice(0, -1),
      { ...items[999]!, text: "Stable response 999 + streamed delta" },
    ];
    rerender(
      <Conversation threadKey="long-thread" items={nextItems} isThinking />,
    );

    expect(renderedMessageIds).toEqual(["assistant-999"]);
  });
});

import { Fragment } from "react";
import { View } from "react-native";
import { act } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ConversationRenderBlock } from "@falcondeck/client-core";

import { renderComponent } from "@/test/render";

const { renderedAssistantIds } = vi.hoisted(() => ({
  renderedAssistantIds: [] as string[],
}));

vi.mock("./AssistantMessageBlock", () => ({
  AssistantMessageBlock: ({ item }: { item: { id: string } }) => {
    renderedAssistantIds.push(item.id);
    return <View />;
  },
}));

import { MessageRouter } from "./MessageRouter";

const ignoreApprovalDecision = () => {};

function Transcript({ blocks }: { blocks: ConversationRenderBlock[] }) {
  return (
    <Fragment>
      {blocks.map((block) => (
        <MessageRouter
          key={block.id}
          item={block}
          onApprovalDecision={ignoreApprovalDecision}
        />
      ))}
    </Fragment>
  );
}

describe("MessageRouter render isolation", () => {
  beforeEach(() => {
    renderedAssistantIds.length = 0;
  });

  it("reconciles only the changed tail row during a 1,000-message stream update", () => {
    const blocks: ConversationRenderBlock[] = Array.from(
      { length: 1_000 },
      (_, index) => ({
        kind: "item",
        id: `assistant_message:assistant-${index}`,
        item: {
          kind: "assistant_message",
          id: `assistant-${index}`,
          text: `Stable response ${index}`,
          lifecycle: index === 999 ? "streaming" : "complete",
          created_at: "2026-08-08T12:00:00Z",
        },
        default_open: false,
        suppress_read_only_detail: false,
      }),
    );
    const renderer = renderComponent(<Transcript blocks={blocks} />);

    expect(renderedAssistantIds).toHaveLength(1_000);
    renderedAssistantIds.length = 0;

    const tail = blocks[999]!;
    if (tail.kind !== "item" || tail.item.kind !== "assistant_message") {
      throw new Error("Expected an assistant-message row");
    }
    const nextBlocks: ConversationRenderBlock[] = [
      ...blocks.slice(0, -1),
      {
        ...tail,
        item: {
          ...tail.item,
          text: "Stable response 999 + streamed delta",
        },
      },
    ];
    act(() => {
      renderer.update(<Transcript blocks={nextBlocks} />);
    });

    expect(renderedAssistantIds).toEqual(["assistant-999"]);
  });
});

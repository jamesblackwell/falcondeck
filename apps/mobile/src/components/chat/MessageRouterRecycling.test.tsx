import React from "react";
import { act } from "react-test-renderer";
import { afterEach, describe, expect, it } from "vitest";

import type {
  ConversationItem,
  ConversationRenderBlock,
} from "@falcondeck/client-core";

import { cleanup, renderComponent, textOf } from "@/test/render";
import { MessageRouter } from "./MessageRouter";

afterEach(cleanup);

const ignoreApprovalDecision = () => {};

function itemBlock(item: ConversationItem): ConversationRenderBlock {
  return {
    kind: "item",
    id: `${item.kind}:${item.id}`,
    item,
    default_open: false,
    suppress_read_only_detail: false,
  };
}

function citedAssistant(id: string, title: string): ConversationItem {
  return {
    kind: "assistant_message",
    id,
    text: `Response ${id}`,
    citations: [
      {
        kind: "web_search_result_location",
        url: `https://example.com/${id}`,
        title,
        cited_text: `Evidence for ${id}`,
      },
    ],
    lifecycle: "complete",
    created_at: "2026-08-10T06:00:00Z",
  };
}

function artifact(id: string, marker: string): ConversationItem {
  return {
    kind: "artifact",
    id,
    artifact: {
      title: `${id}.json`,
      artifact_kind: "report",
      url: null,
      mime_type: "application/json",
      version: null,
      content: null,
      payload: { marker },
    },
    lifecycle: "complete",
    created_at: "2026-08-10T06:00:00Z",
  };
}

describe("MessageRouter recycling", () => {
  it("resets disclosure state when FlashList reuses a cell for another block", () => {
    const renderer = renderComponent(
      <MessageRouter
        item={itemBlock(citedAssistant("assistant-a", "Source A"))}
        onApprovalDecision={ignoreApprovalDecision}
      />,
    );
    const firstDisclosure = renderer.root.findByProps({
      accessibilityLabel: "1 cited source",
    });
    act(() => firstDisclosure.props.onPress());
    expect(firstDisclosure.props.accessibilityState).toEqual({
      expanded: true,
    });
    expect(textOf(renderer)).toContain("Source A");

    act(() => {
      renderer.update(
        <MessageRouter
          item={itemBlock(citedAssistant("assistant-b", "Source B"))}
          onApprovalDecision={ignoreApprovalDecision}
        />,
      );
    });

    const recycledDisclosure = renderer.root.findByProps({
      accessibilityLabel: "1 cited source",
    });
    expect(recycledDisclosure.props.accessibilityState).toEqual({
      expanded: false,
    });
    expect(textOf(renderer)).not.toContain("Source A");
    expect(textOf(renderer)).not.toContain("Source B");
  });

  it("preserves disclosure state across authoritative updates to the same block", () => {
    const renderer = renderComponent(
      <MessageRouter
        item={itemBlock(citedAssistant("assistant-a", "Source A"))}
        onApprovalDecision={ignoreApprovalDecision}
      />,
    );
    act(() =>
      renderer.root
        .findByProps({ accessibilityLabel: "1 cited source" })
        .props.onPress(),
    );

    act(() => {
      renderer.update(
        <MessageRouter
          item={itemBlock(citedAssistant("assistant-a", "Updated source"))}
          onApprovalDecision={ignoreApprovalDecision}
        />,
      );
    });

    expect(
      renderer.root.findByProps({ accessibilityLabel: "1 cited source" }).props
        .accessibilityState,
    ).toEqual({ expanded: true });
    expect(textOf(renderer)).toContain("Updated source");
  });

  it("applies the same reset boundary to other stateful output renderers", () => {
    const renderer = renderComponent(
      <MessageRouter
        item={itemBlock(artifact("artifact-a", "FIRST_MARKER"))}
        onApprovalDecision={ignoreApprovalDecision}
      />,
    );
    act(() =>
      renderer.root
        .findByProps({ accessibilityLabel: "Artifact technical details" })
        .props.onPress(),
    );
    expect(textOf(renderer)).toContain("FIRST_MARKER");

    act(() => {
      renderer.update(
        <MessageRouter
          item={itemBlock(artifact("artifact-b", "SECOND_MARKER"))}
          onApprovalDecision={ignoreApprovalDecision}
        />,
      );
    });

    expect(
      renderer.root.findByProps({
        accessibilityLabel: "Artifact technical details",
      }).props.accessibilityState,
    ).toEqual({ expanded: false });
    expect(textOf(renderer)).not.toContain("FIRST_MARKER");
    expect(textOf(renderer)).not.toContain("SECOND_MARKER");
  });
});

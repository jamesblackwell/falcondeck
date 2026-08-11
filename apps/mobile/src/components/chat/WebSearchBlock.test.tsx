import React from "react";
import { Linking } from "react-native";
import { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ContentLifecycle,
  ConversationItem,
  WebSearchActionKind,
} from "@falcondeck/client-core";

import { cleanup, renderComponent, textOf } from "@/test/render";
import { WebSearchBlock } from "./WebSearchBlock";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function searchItem(
  lifecycle: ContentLifecycle,
  actionKind: WebSearchActionKind = "search",
  url: string | null = null,
) {
  return {
    kind: "web_search",
    id: `search-${lifecycle}`,
    search: {
      id: `search-${lifecycle}-action`,
      query: "React streaming chat best practices",
      action_kind: actionKind,
      queries: ["React streaming chat", "AI message parts"],
      url,
      pattern: actionKind === "find_in_page" ? "streaming" : null,
    },
    lifecycle,
    created_at: "2026-08-09T12:00:00Z",
  } satisfies Extract<ConversationItem, { kind: "web_search" }>;
}

describe("WebSearchBlock", () => {
  it("shows streaming and batched query context", () => {
    const renderer = renderComponent(
      <WebSearchBlock item={searchItem("streaming")} />,
    );
    expect(textOf(renderer)).toContain("Searching web");
    expect(textOf(renderer)).toContain("2 related queries");
    expect(
      renderer.root.findByProps({
        accessibilityLabel: "Searching web, in progress",
      }),
    ).toBeDefined();
    expect(textOf(renderer)).not.toContain("AI message parts");
    const disclosure = renderer.root.findByProps({
      accessibilityLabel: "2 related queries",
    });
    act(() => disclosure.props.onPress());
    expect(textOf(renderer)).toContain("AI message parts");
    expect(disclosure.props.accessibilityState).toEqual({ expanded: true });
  });

  it("opens safe source pages", async () => {
    const openUrl = vi.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    const renderer = renderComponent(
      <WebSearchBlock
        item={searchItem(
          "complete",
          "open_page",
          "https://docs.example.com/chat",
        )}
      />,
    );
    const link = renderer.root.findByProps({
      accessibilityLabel: "Open source page on docs.example.com",
    });
    await act(async () => {
      link.props.onPress();
      await Promise.resolve();
    });
    expect(openUrl).toHaveBeenCalledWith("https://docs.example.com/chat");
  });

  it("announces a browser handoff as busy and coalesces repeated taps", async () => {
    let resolveHandoff!: () => void;
    const handoff = new Promise<void>((resolve) => {
      resolveHandoff = resolve;
    });
    const openUrl = vi.spyOn(Linking, "openURL").mockReturnValue(handoff);
    const renderer = renderComponent(
      <WebSearchBlock
        item={searchItem(
          "complete",
          "open_page",
          "https://docs.example.com/chat",
        )}
      />,
    );
    const link = renderer.root.findByProps({
      accessibilityLabel: "Open source page on docs.example.com",
    });

    act(() => {
      link.props.onPress();
      link.props.onPress();
    });
    expect(openUrl).toHaveBeenCalledTimes(1);
    expect(link.props.accessibilityState).toEqual({ busy: true });
    expect(link.props.accessibilityHint).toBe(
      "Opening this source page in your browser",
    );

    await act(async () => {
      resolveHandoff();
      await handoff;
    });
    expect(link.props.accessibilityState).toEqual({ busy: false });
  });

  it("keeps a failed source handoff visible and retryable", async () => {
    const openUrl = vi
      .spyOn(Linking, "openURL")
      .mockRejectedValueOnce(new Error("No browser available"))
      .mockResolvedValue(undefined);
    const renderer = renderComponent(
      <WebSearchBlock
        item={searchItem(
          "complete",
          "open_page",
          "https://docs.example.com/chat",
        )}
      />,
    );
    const link = renderer.root.findByProps({
      accessibilityLabel: "Open source page on docs.example.com",
    });

    await act(async () => {
      await link.props.onPress();
    });
    expect(textOf(renderer)).toContain(
      "Could not open source page. Tap to retry.",
    );
    expect(link.props.accessibilityHint).toBe(
      "Retries opening this source page in your browser",
    );

    await act(async () => {
      await link.props.onPress();
    });
    expect(openUrl).toHaveBeenCalledTimes(2);
    expect(textOf(renderer)).not.toContain(
      "Could not open source page. Tap to retry.",
    );
  });

  it("does not expose unsafe provider URLs as links", () => {
    const renderer = renderComponent(
      <WebSearchBlock
        item={searchItem("complete", "open_page", "javascript:alert(1)")}
      />,
    );
    expect(() =>
      renderer.root.findByProps({ accessibilityRole: "link" }),
    ).toThrow();
  });

  it("does not expose credential-bearing or control-character URLs as links", () => {
    for (const url of [
      "https://user:secret@example.com/research",
      "https://example.com/\nresearch",
    ]) {
      const renderer = renderComponent(
        <WebSearchBlock item={searchItem("complete", "open_page", url)} />,
      );
      expect(() =>
        renderer.root.findByProps({ accessibilityRole: "link" }),
      ).toThrow();
      act(() => renderer.unmount());
    }
  });

  it("shows find context and failure without discarding the action", () => {
    const renderer = renderComponent(
      <WebSearchBlock
        item={searchItem("error", "find_in_page", "https://example.com")}
      />,
    );
    expect(textOf(renderer)).toContain("Find: streaming");
    expect(textOf(renderer)).toContain("Failed");
    expect(
      renderer.root.findByProps({ accessibilityRole: "alert" }),
    ).toBeDefined();
    expect(
      renderer.root
        .findAllByType("Text" as any)
        .some(
          (node) =>
            node.props.selectable === true &&
            node.children.includes("streaming"),
        ),
    ).toBe(true);
  });

  it("retains interrupted research as a partial, announced receipt", () => {
    const renderer = renderComponent(
      <WebSearchBlock
        item={searchItem("interrupted", "open_page", "https://example.com")}
      />,
    );
    expect(textOf(renderer)).toContain("Opened page");
    expect(textOf(renderer)).toContain("Interrupted");
    expect(
      renderer.root.findByProps({ accessibilityLiveRegion: "polite" }),
    ).toBeDefined();
    expect(
      renderer.root.findByProps({ accessibilityRole: "link" }),
    ).toBeDefined();
  });

  it("keeps future provider actions intelligible", () => {
    const renderer = renderComponent(
      <WebSearchBlock item={searchItem("streaming", "capturePage")} />,
    );

    expect(textOf(renderer)).toContain("Capture page…");
  });
});

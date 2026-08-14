import React from "react";
import { Linking } from "react-native";
import { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConversationItem } from "@falcondeck/client-core";

import { cleanup, renderComponent, textOf } from "@/test/render";
import { AssistantMessageBlock } from "./AssistantMessageBlock";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function assistant(
  overrides: Partial<
    Extract<ConversationItem, { kind: "assistant_message" }>
  > = {},
) {
  return {
    kind: "assistant_message",
    id: "assistant-1",
    text: "The replay invariant is documented.",
    phase: "final_answer",
    memory_citation: null,
    lifecycle: "complete",
    created_at: "2026-08-09T12:00:00Z",
    ...overrides,
  } satisfies Extract<ConversationItem, { kind: "assistant_message" }>;
}

describe("AssistantMessageBlock metadata", () => {
  it("labels commentary as a progress update", () => {
    const renderer = renderComponent(
      <AssistantMessageBlock
        item={assistant({ phase: "commentary", lifecycle: "streaming" })}
      />,
    );
    expect(textOf(renderer)).toContain("PROGRESS UPDATE");
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: "Response streaming" }),
    ).toHaveLength(0);
  });

  it("expands structured memory evidence accessibly", () => {
    const renderer = renderComponent(
      <AssistantMessageBlock
        item={assistant({
          memory_citation: {
            entries: [
              {
                path: "docs/PLATFORM.md",
                line_start: 170,
                line_end: 178,
                note: "Defines replay identity and ordering.",
              },
            ],
            thread_ids: ["thread-earlier"],
          },
        })}
      />,
    );
    const disclosure = renderer.root.findByProps({
      accessibilityLabel: "1 memory source",
    });
    expect(disclosure.props.accessibilityState).toEqual({ expanded: false });
    expect(textOf(renderer)).not.toContain("docs/PLATFORM.md");
    act(() => disclosure.props.onPress());
    expect(disclosure.props.accessibilityState).toEqual({ expanded: true });
    expect(textOf(renderer)).toContain("docs/PLATFORM.md:170–178");
    expect(textOf(renderer)).toContain("Defines replay identity and ordering.");
    expect(textOf(renderer)).toContain("1 thread");
  });

  it("expands and opens safe provider citations", async () => {
    const openUrl = vi
      .spyOn(Linking, "openURL")
      .mockResolvedValueOnce(undefined);
    const renderer = renderComponent(
      <AssistantMessageBlock
        item={assistant({
          citations: [
            {
              kind: "search_result_location",
              source: "https://react.dev/blog/2024/12/05/react-19",
              title: "React v19",
              cited_text: "React 19 is now stable!",
              locator: {
                kind: "search_result",
                search_result_index: 2,
                start_block_index: 4,
                end_block_index: 5,
              },
            },
          ],
        })}
      />,
    );

    const disclosure = renderer.root.findByProps({
      accessibilityLabel: "1 cited source",
    });
    expect(disclosure.props.accessibilityState).toEqual({ expanded: false });
    act(() => disclosure.props.onPress());
    const source = renderer.root.findByProps({
      accessibilityLabel: "Open cited source: React v19",
    });
    expect(source.props.accessibilityRole).toBe("link");
    expect(textOf(renderer)).toContain("React 19 is now stable!");
    expect(textOf(renderer)).toContain("Result 3 · block 5");
    expect(
      renderer.root
        .findAllByType("Text" as any)
        .some(
          (node) =>
            node.props.selectable === true &&
            node.children.includes("Result 3 · block 5"),
        ),
    ).toBe(true);
    await act(async () => {
      source.props.onPress();
      await Promise.resolve();
    });
    expect(openUrl).toHaveBeenCalledWith(
      "https://react.dev/blog/2024/12/05/react-19",
    );
  });

  it("reveals large citation sets progressively and bounds excerpts", () => {
    const citations = Array.from({ length: 45 }, (_, index) => ({
      kind: "search_result_location",
      url: `https://example.com/source-${index + 1}`,
      title: `Source ${index + 1}`,
      cited_text:
        index === 0 ? `Evidence ${"x".repeat(3_000)}` : `Evidence ${index + 1}`,
    }));
    const renderer = renderComponent(
      <AssistantMessageBlock item={assistant({ citations })} />,
    );

    expect(textOf(renderer)).not.toContain("Source 1");
    act(() =>
      renderer.root
        .findByProps({ accessibilityLabel: "45 cited sources" })
        .props.onPress(),
    );
    expect(textOf(renderer)).toContain("Source 20");
    expect(textOf(renderer)).not.toContain("Source 21");
    expect(textOf(renderer)).toContain("Excerpt limited for performance.");

    act(() =>
      renderer.root
        .findByProps({
          accessibilityLabel: "Show 20 more cited sources",
        })
        .props.onPress(),
    );
    expect(textOf(renderer)).toContain("Source 40");
    expect(textOf(renderer)).not.toContain("Source 41");
    expect(
      renderer.root.findByProps({
        accessibilityLabel: "Show 5 more cited sources",
      }),
    ).toBeDefined();
  });

  it("shows a retryable receipt when a safe source cannot open", async () => {
    vi.spyOn(Linking, "openURL").mockRejectedValueOnce(new Error("no browser"));
    const renderer = renderComponent(
      <AssistantMessageBlock
        item={assistant({
          citations: [
            {
              kind: "web_search_result_location",
              url: "https://example.com/source",
              title: "Provider source",
            },
          ],
        })}
      />,
    );
    act(() =>
      renderer.root
        .findByProps({ accessibilityLabel: "1 cited source" })
        .props.onPress(),
    );

    await act(async () => {
      renderer.root
        .findByProps({
          accessibilityLabel: "Open cited source: Provider source",
        })
        .props.onPress();
      await Promise.resolve();
    });

    expect(textOf(renderer)).toContain("Could not open source. Tap to retry.");
    expect(
      renderer.root.findByProps({ accessibilityRole: "alert" }),
    ).toBeDefined();
    expect(
      renderer.root.findByProps({
        accessibilityHint: "Retries opening this source in your browser",
      }),
    ).toBeDefined();
  });

  it("does not offer retry for a terminal answer", () => {
    const onRetryResponse = vi.fn();
    const source = {
      kind: "user_message" as const,
      id: "user-1",
      text: "Try this again",
      attachments: [],
      turn_id: "turn-1",
      previous_turn_id: null,
      created_at: "2026-08-09T11:59:00Z",
    };
    const renderer = renderComponent(
      <AssistantMessageBlock
        item={assistant()}
        retrySource={source}
        onRetryResponse={onRetryResponse}
      />,
    );
    expect(
      renderer.root.findAllByProps({
        accessibilityLabel: "Try response again in a new branch",
      }),
    ).toHaveLength(0);
    expect(onRetryResponse).not.toHaveBeenCalled();
  });
});

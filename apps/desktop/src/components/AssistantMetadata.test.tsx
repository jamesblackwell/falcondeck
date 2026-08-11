import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageCard } from "@falcondeck/chat-ui";
import type { ConversationItem } from "@falcondeck/client-core";

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

describe("assistant message metadata", () => {
  it("distinguishes interim commentary from a final answer", () => {
    render(
      <MessageCard
        item={assistant({ phase: "commentary", lifecycle: "streaming" })}
      />,
    );
    expect(
      screen.getByRole("article", {
        name: "Assistant progress update, streaming",
      }),
    ).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Progress update")).toBeInTheDocument();
  });

  it("renders structured memory citations as expandable evidence", () => {
    render(
      <MessageCard
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
    const disclosure = screen.getByText("1 memory source");
    expect(screen.queryByText("docs/PLATFORM.md")).toBeNull();
    fireEvent.click(disclosure);
    expect(screen.getByText("docs/PLATFORM.md")).toBeVisible();
    expect(screen.getByText(":170–178")).toBeVisible();
    expect(
      screen.getByText("Defines replay identity and ordering."),
    ).toBeVisible();
    expect(screen.getByText("1 thread")).toBeVisible();
  });

  it("renders provider citations as safe expandable source evidence", () => {
    render(
      <MessageCard
        item={assistant({
          citations: [
            {
              kind: "web_search_result_location",
              url: "https://react.dev/blog/2024/12/05/react-19",
              title: "React v19",
              cited_text: "React 19 is now stable!",
            },
            {
              kind: "search_result_location",
              source: "https://docs.example.com/release-notes",
              title: "Internal release notes",
              cited_text: "The release is generally available.",
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

    const disclosure = screen.getByText("2 cited sources");
    expect(screen.queryByText("React v19")).toBeNull();
    fireEvent.click(disclosure);
    expect(
      screen.getByRole("link", { name: "Open cited source: React v19" }),
    ).toHaveAttribute("href", "https://react.dev/blog/2024/12/05/react-19");
    expect(screen.getByText("React 19 is now stable!")).toBeVisible();
    expect(screen.getByText("Internal release notes")).toBeVisible();
    expect(
      screen.getByRole("link", {
        name: "Open cited source: Internal release notes",
      }),
    ).toHaveAttribute("href", "https://docs.example.com/release-notes");
    expect(screen.getByText("Result 3 · block 5")).toBeVisible();
  });

  it("reveals large citation sets progressively and bounds excerpts", () => {
    const citations = Array.from({ length: 45 }, (_, index) => ({
      kind: "search_result_location",
      url: `https://example.com/source-${index + 1}`,
      title: `Source ${index + 1}`,
      cited_text:
        index === 0 ? `Evidence ${"x".repeat(3_000)}` : `Evidence ${index + 1}`,
    }));
    render(<MessageCard item={assistant({ citations })} />);

    expect(screen.queryByText("Source 1")).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Open cited source: Source 1" }),
    ).toBeNull();
    fireEvent.click(screen.getByText("45 cited sources"));
    expect(screen.getByText("Source 20")).toBeVisible();
    expect(screen.queryByText("Source 21")).toBeNull();
    expect(screen.getByText("Excerpt limited for performance.")).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "Show 20 more cited sources" }),
    );
    expect(screen.getByText("Source 40")).toBeVisible();
    expect(screen.queryByText("Source 41")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Show 5 more cited sources" }),
    ).toBeVisible();
  });

  it("does not expose malformed or credential-bearing citations as links", () => {
    render(
      <MessageCard
        item={assistant({
          citations: [
            { kind: "web", url: "https://", title: "Malformed" },
            {
              kind: "web",
              url: "https://user:secret@example.com",
              title: "Credentials",
            },
          ],
        })}
      />,
    );

    fireEvent.click(screen.getByText("2 cited sources"));
    expect(
      screen.queryByRole("link", { name: /Malformed|Credentials/ }),
    ).toBeNull();
    expect(screen.getByText("Malformed")).toBeVisible();
    expect(screen.getByText("Credentials")).toBeVisible();
  });

  it("keeps legacy phase-less responses visually compatible", () => {
    render(<MessageCard item={assistant({ phase: null })} />);
    expect(
      screen.getByRole("article", { name: "Assistant message, complete" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Progress update")).not.toBeInTheDocument();
  });
});

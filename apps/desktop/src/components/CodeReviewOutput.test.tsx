import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MessageCard } from "@falcondeck/chat-ui";
import type {
  ContentLifecycle,
  ConversationItem,
} from "@falcondeck/client-core";

function review(
  lifecycle: ContentLifecycle,
  content = "",
): Extract<ConversationItem, { kind: "code_review" }> {
  return {
    kind: "code_review",
    id: "review-1",
    subject: "current changes",
    content,
    lifecycle,
    created_at: "2026-08-09T10:00:00Z",
  };
}

describe("code review output", () => {
  it("shows a calm busy receipt while the provider reviews the target", () => {
    render(<MessageCard item={review("streaming")} />);

    const status = screen.getByRole("status", {
      name: "Reviewing current changes. Inspecting the requested code and preparing findings.",
    });
    expect(status).toHaveAttribute("aria-busy", "true");
  });

  it("renders completed findings as Markdown with a copy action", () => {
    render(
      <MessageCard
        item={review("complete", "## Findings\n\n- Fix the reconnect race.")}
      />,
    );

    expect(
      screen.getByRole("article", { name: "Code review, complete" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Findings" })).toBeVisible();
    expect(screen.getByText("Fix the reconnect race.")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Copy code review" }),
    ).toBeInTheDocument();
  });

  it("keeps provider directive-looking text literal in display and copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <MessageCard
        item={review(
          "complete",
          "## Findings\n\nReady.\n::future-review-action{state=ready provider-fragment}",
        )}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy code review" }));
    });

    expect(screen.getByText(/::future-review-action/)).toBeVisible();
    expect(screen.queryByText("future review action")).not.toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith(
      "## Findings\n\nReady.\n::future-review-action{state=ready provider-fragment}",
    );
  });

  it("does not copy an unfinished action while review findings are streaming", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <MessageCard
        item={review(
          "streaming",
          "Partial finding.\n::future-review-action{state=run",
        )}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy code review" }));
    });

    expect(writeText).toHaveBeenCalledWith(
      "Partial finding.\n::future-review-action{state=run",
    );
  });

  it("keeps partial findings visible with assertive failure semantics", () => {
    render(
      <MessageCard
        item={review("error", "## Partial finding\n\nThe test can race.")}
      />,
    );

    expect(
      screen.getByRole("article", { name: "Code review, error" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Review failed");
    expect(screen.getByText("The test can race.")).toBeVisible();
  });

  it("shows an interrupted receipt even if no findings arrived", () => {
    render(<MessageCard item={review("interrupted")} />);

    expect(screen.getByRole("status")).toHaveAccessibleName(
      "Code review interrupted. The review of current changes stopped before completion.",
    );
  });
});

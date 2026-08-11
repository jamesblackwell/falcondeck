import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageCard } from "@falcondeck/chat-ui";
import {
  normalizeConversationItem,
  type ConversationItem,
} from "@falcondeck/client-core";

describe("unsupported conversation output", () => {
  it("stays visible and exposes its raw payload for forward compatibility", () => {
    render(
      <MessageCard
        item={
          {
            kind: "artifact_preview",
            id: "future-1",
            url: "https://example.com",
          } as unknown as ConversationItem
        }
      />,
    );

    expect(screen.queryByText(/"url": "https:\/\/example.com"/)).toBeNull();
    const summary = screen.getByText("Unsupported output: artifact preview");
    fireEvent.click(summary);
    expect(
      screen.getByText(/"url": "https:\/\/example.com"/),
    ).toBeInTheDocument();
  });

  it("bounds adversarial future payloads and discloses the display limit", () => {
    render(
      <MessageCard
        item={
          {
            kind: "future_trace",
            id: "future-2",
            payload: "x".repeat(25_000),
          } as unknown as ConversationItem
        }
      />,
    );

    fireEvent.click(screen.getByText("Unsupported output: future trace"));
    expect(
      screen.getByText("Display limited for performance and safety."),
    ).toBeVisible();
    expect(
      screen.getByText(/characters omitted/).textContent?.length,
    ).toBeLessThan(21_000);
  });

  it("routes malformed known output to the fallback without losing evidence", () => {
    const item = normalizeConversationItem({
      kind: "assistant_message",
      id: "broken-assistant",
      text: { unexpected: "structured text" },
    });
    render(<MessageCard item={item} />);

    fireEvent.click(screen.getByText("Unsupported output: assistant message"));
    expect(screen.getByText(/"unexpected": "structured text"/)).toBeVisible();
  });

  it("shows the lifecycle and inspects only the provider payload", () => {
    const item = normalizeConversationItem({
      kind: "unsupported",
      id: "future-1",
      output_kind: "artifactPreview",
      reason: "Provider output is not supported by this FalconDeck version",
      payload: { title: "Prototype" },
      lifecycle: "streaming",
      created_at: "2026-08-09T10:00:00Z",
    });
    render(<MessageCard item={item} />);

    const receipt = screen.getByRole("group", {
      name: "Unsupported output: artifact preview. Streaming. Provider output is not supported by this FalconDeck version",
    });
    expect(receipt).not.toHaveAttribute("aria-live");
    expect(screen.getByText("Streaming").parentElement).toHaveAttribute(
      "aria-live",
      "polite",
    );
    fireEvent.click(screen.getByText("Unsupported output: artifact preview"));
    expect(receipt).toHaveTextContent("Streaming");
    expect(screen.getByText(/"title": "Prototype"/)).toBeVisible();
    expect(screen.queryByText(/created_at/)).not.toBeInTheDocument();
  });
});

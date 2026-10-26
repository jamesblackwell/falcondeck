import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConversationItem } from "@falcondeck/client-core";

import { MessageCard } from "./message";

const message = {
  kind: "user_message",
  id: "agent-message-1",
  text: "Message from FalconDeck thread task-1 (Quizgecko):\n\nPhase 3 accepted.\n\n**Fix the critical path.**\n\nFinal detail.",
  attachments: [],
  created_at: "2026-10-26T12:00:00Z",
} satisfies Extract<ConversationItem, { kind: "user_message" }>;

describe("messages from another FalconDeck task", () => {
  it("starts as a quiet sender row and toggles the complete message", () => {
    render(<MessageCard item={message} collapseLongUserMessages={false} defaultOpen />);
    const trigger = screen.getByRole("button", { name: "Agent message from Quizgecko" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Final detail.")).not.toBeInTheDocument();
    expect(screen.queryByText(/Message from FalconDeck thread/)).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Fix the critical path.").tagName).toBe("STRONG");
    expect(screen.getByText("Final detail.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy message" })).toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.queryByText("Final detail.")).not.toBeInTheDocument();
  });

  it("resets expansion when a different message replaces the row", () => {
    const { rerender } = render(<MessageCard item={message} />);
    fireEvent.click(screen.getByRole("button", { name: "Agent message from Quizgecko" }));
    rerender(<MessageCard item={{ ...message, id: "agent-message-2" }} />);
    expect(screen.getByRole("button", { name: "Agent message from Quizgecko" }))
      .toHaveAttribute("aria-expanded", "false");
  });

  it("uses a readable fallback for an untitled source", () => {
    render(<MessageCard item={{ ...message, text: message.text.replace("(Quizgecko)", "()") }} />);
    expect(screen.getByRole("button", { name: "Agent message from another task" })).toBeInTheDocument();
  });

  it("keeps attachments accessible through the existing message presentation", () => {
    render(<MessageCard item={{
      ...message,
      attachments: [{ type: "image", id: "image-1", url: "https://example.com/image.png", mime_type: "image/png", name: "Reference" }],
    }} />);
    expect(screen.getByRole("button", { name: "Preview Reference" })).toBeInTheDocument();
  });

  it("leaves manual prompts as ordinary messages", () => {
    render(<MessageCard item={{ ...message, text: "Please check Quizgecko" }} />);
    expect(screen.getByText("Please check Quizgecko")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Agent message from/ })).not.toBeInTheDocument();
  });
});

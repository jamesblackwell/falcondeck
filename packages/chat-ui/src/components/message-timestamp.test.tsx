import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageCard } from "./message";

const created_at = "2026-11-03T14:35:00Z";

function expectAbsoluteTimestamp(element: HTMLElement) {
  const title = element.getAttribute("title");
  expect(title).toContain("2026");
  expect(title).toContain("November");
  expect(title).toContain("35");
  expect(title).not.toMatch(/ago|Invalid Date/);
}

describe("message timestamp hover", () => {
  it("exposes the timestamp on assistant replies without a visible received-at stamp", () => {
    render(<MessageCard item={{ kind: "assistant_message", id: "assistant", text: "Done", lifecycle: "complete", created_at }} />);
    expectAbsoluteTimestamp(screen.getByRole("article"));
  });

  it("exposes the timestamp on ordinary user messages", () => {
    render(<MessageCard item={{ kind: "user_message", id: "user", text: "Please check", attachments: [], created_at }} />);
    expectAbsoluteTimestamp(screen.getByText("Please check").closest("[title]")!);
  });

  it("exposes the timestamp while a message from another task is collapsed", () => {
    render(<MessageCard item={{ kind: "user_message", id: "agent", text: "Message from FalconDeck thread task-1 (Backup):\n\nDone", attachments: [], created_at }} />);
    expectAbsoluteTimestamp(screen.getByRole("button", { name: "Agent message from Backup" }).closest("[title]")!);
  });

  it("omits the tooltip when a historic message has no valid timestamp", () => {
    render(<MessageCard item={{ kind: "assistant_message", id: "assistant", text: "Done", lifecycle: "complete", created_at: "" }} />);
    expect(screen.getByRole("article")).not.toHaveAttribute("title");
  });
});

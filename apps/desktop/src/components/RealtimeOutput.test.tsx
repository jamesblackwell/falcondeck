import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageCard } from "@falcondeck/chat-ui";

describe("realtime output", () => {
  it("labels handoffs and keeps their provider payload inspectable", () => {
    render(
      <MessageCard
        item={{
          kind: "realtime",
          id: "handoff-1",
          item_type: "handoff_request",
          title: "Voice handoff requested",
          summary: "Continue in Codex.",
          payload: { type: "handoff_request", destination: "codex" },
          created_at: "2026-08-09T10:00:00Z",
        }}
      />,
    );

    const summary = screen.getByText("Voice handoff requested");
    expect(screen.getByText("Continue in Codex.")).toBeVisible();
    expect(screen.queryByText(/"destination": "codex"/)).toBeNull();
    fireEvent.click(summary);
    expect(screen.getByText(/"destination": "codex"/)).toBeVisible();
  });

  it("bounds larger realtime evidence behind expansion and copy controls", () => {
    const payload = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [
        `field_${index}`,
        `value_${index}`,
      ]),
    );
    render(
      <MessageCard
        item={{
          kind: "realtime",
          id: "handoff-large",
          item_type: "handoff_request",
          title: "Voice handoff requested",
          summary: "Continue in Codex.",
          payload,
          created_at: "2026-08-09T10:00:00Z",
        }}
      />,
    );

    fireEvent.click(screen.getByText("Voice handoff requested"));
    expect(screen.getByRole("button", { name: "Copy" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Show 18 more lines" }),
    ).toBeVisible();
    expect(
      screen.queryByText(/"field_23": "value_23"/),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show 18 more lines" }));
    expect(screen.getByText(/"field_23": "value_23"/)).toBeVisible();
  });
});

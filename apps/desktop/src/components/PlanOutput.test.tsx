import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageCard } from "@falcondeck/chat-ui";
import type { ConversationItem } from "@falcondeck/client-core";

const item = {
  kind: "plan",
  id: "plan-1",
  plan: {
    explanation: "Ship a reliable conversation surface.",
    steps: [
      { id: "inspect", step: "Inspect current state", status: "done" },
      { id: "implement", step: "Implement parity", status: "running" },
      { id: "qa", step: "QA every client", status: "failed" },
      {
        id: "future",
        step: "Handle future provider state",
        status: "paused_by_provider",
      },
    ],
  },
  created_at: "2026-08-09T12:00:00Z",
} satisfies Extract<ConversationItem, { kind: "plan" }>;

describe("plan output presentation", () => {
  it("renders normalized visible and accessible step states", () => {
    render(<MessageCard item={item} />);

    expect(
      screen.getByRole("region", { name: "Plan, 4 steps" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Plan" })).toBeInTheDocument();
    expect(screen.getByRole("list")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    expect(
      screen.getByLabelText("Inspect current state, Completed"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Implement parity, In progress"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("QA every client, Failed"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Handle future provider state, Paused by provider"),
    ).toBeInTheDocument();
  });
});

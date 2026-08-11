import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageCard } from "@falcondeck/chat-ui";

describe("service output severity", () => {
  it("renders friendly skill-icon warning copy with expandable raw detail", () => {
    const raw = JSON.stringify({
      level: "WARN",
      fields: {
        message:
          "ignoring interface.icon_large: icon path with '.' must resolve under plugin assets/",
      },
      target: "codex_core::skills::loader",
    });
    render(
      <MessageCard
        item={{
          kind: "service",
          id: "skill-warning",
          level: "warning",
          message: raw,
          created_at: "2026-08-09T10:00:00Z",
        }}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The skill is still available.",
    );
    expect(
      screen.getByText("Technical details").closest("details"),
    ).not.toHaveAttribute("open");
  });

  it("announces multiline warnings without styling them as quiet receipts", () => {
    render(
      <MessageCard
        item={{
          kind: "service",
          id: "warning-1",
          level: "warning",
          message: "Safety buffering enabled\nFaster model available",
          created_at: "2026-08-09T10:00:00Z",
        }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "Safety buffering enabled Faster model available",
    );
    expect(alert.className).toContain("border-warning");
  });

  it("shows readable generic diagnostic copy with collapsed exact detail", () => {
    const raw = JSON.stringify({
      level: "ERROR",
      fields: {
        message: "MCP server could not start. Check its configuration.",
      },
      target: "codex_core::mcp",
    });
    render(
      <MessageCard
        item={{
          kind: "service",
          id: "mcp-error",
          level: "error",
          message: raw,
          created_at: "2026-08-09T10:00:00Z",
        }}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "MCP server could not start. Check its configuration.",
    );
    expect(screen.queryByText(/codex_core::mcp/)).toBeNull();
    expect(
      screen.getByText("Technical details").closest("details"),
    ).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText(/codex_core::mcp/)).toBeVisible();
  });

  it("bounds very large diagnostics while keeping the complete payload copyable", () => {
    const raw = JSON.stringify({
      level: "ERROR",
      fields: {
        message: "Provider trace exceeded the inline display budget.",
        trace: "x".repeat(250_000),
      },
    });
    render(
      <MessageCard
        item={{
          kind: "service",
          id: "large-error",
          level: "error",
          message: raw,
          created_at: "2026-08-09T10:00:00Z",
        }}
      />,
    );

    fireEvent.click(screen.getByText("Technical details"));
    expect(
      screen.getByText(
        "Display limited for performance. Copy includes the complete output.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy" })).toBeVisible();
    expect(screen.getByText("diagnostic")).toBeVisible();
  });
});

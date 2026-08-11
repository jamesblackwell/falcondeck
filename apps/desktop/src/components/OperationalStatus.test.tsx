import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { OperationalNotice } from "@falcondeck/chat-ui";

describe("operational conversation status", () => {
  it("summarizes invalid skill icons and keeps the raw diagnostic expandable", () => {
    const raw = JSON.stringify({
      level: "WARN",
      fields: {
        message:
          "ignoring interface.icon_large: icon path with '.' must resolve under plugin assets/",
      },
      target: "codex_core::skills::loader",
    });
    render(
      <OperationalNotice
        notice={{
          id: "skill-warning",
          workspace_id: "workspace-1",
          level: "warning",
          message: raw,
          raw_method: "provider/warning",
          created_at: "2026-08-09T10:00:00Z",
        }}
        onDismiss={() => {}}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "A skill icon could not be loaded because its path is invalid. The skill is still available.",
    );
    const details = screen.getByText("Technical details").closest("details");
    expect(details).not.toHaveAttribute("open");
    expect(screen.queryByText(/codex_core::skills::loader/)).toBeNull();
    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText(/codex_core::skills::loader/)).toBeVisible();
  });

  it("bounds large workspace diagnostics behind a copyable technical surface", () => {
    const raw = JSON.stringify({
      level: "ERROR",
      fields: {
        message: "Provider configuration could not be loaded.",
        trace: "x".repeat(250_000),
      },
    });
    render(
      <OperationalNotice
        notice={{
          id: "large-diagnostic",
          workspace_id: "workspace-1",
          level: "error",
          message: raw,
          raw_method: "provider/error",
          created_at: "2026-08-09T10:00:00Z",
        }}
        onDismiss={() => {}}
      />,
    );

    fireEvent.click(screen.getByText("Technical details"));
    expect(screen.getByText("diagnostic")).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy" })).toBeVisible();
    expect(
      screen.getByText(
        "Display limited for performance. Copy includes the complete output.",
      ),
    ).toBeVisible();
  });

  it("announces and dismisses retained workspace errors", () => {
    const onDismiss = vi.fn();
    render(
      <OperationalNotice
        notice={{
          id: "notice-1",
          workspace_id: "workspace-1",
          level: "error",
          message: "MCP startup failed",
          raw_method: "mcpServer/startupFailed",
          created_at: "2026-08-09T10:00:00Z",
        }}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("MCP startup failed");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
    expect(onDismiss).toHaveBeenCalledWith("notice-1");
  });
});

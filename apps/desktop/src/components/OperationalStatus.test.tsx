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
        conditions={[
          {
            id: "skill-warning",
            key: "skill_icon",
            workspace_id: "workspace-1",
            level: "warning",
            message: raw,
            source: "provider/warning",
            created_at: "2026-08-09T10:00:00Z",
            updated_at: "2026-08-09T10:00:00Z",
          },
        ]}
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
        conditions={[
          {
            id: "large-diagnostic",
            key: "provider_configuration",
            workspace_id: "workspace-1",
            level: "error",
            message: raw,
            source: "provider/error",
            created_at: "2026-08-09T10:00:00Z",
            updated_at: "2026-08-09T10:00:00Z",
          },
        ]}
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
        conditions={[
          {
            id: "notice-1",
            key: "mcp_startup:test",
            workspace_id: "workspace-1",
            level: "error",
            message: "MCP startup failed",
            source: "mcpServer/startupFailed",
            created_at: "2026-08-09T10:00:00Z",
            updated_at: "2026-08-09T10:00:00Z",
          },
        ]}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("MCP startup failed");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss issue" }));
    expect(onDismiss).toHaveBeenCalledWith(
      expect.objectContaining({ id: "notice-1" }),
    );
  });

  it("opens a compact message center when several conditions are active", () => {
    render(
      <OperationalNotice
        conditions={[
          {
            id: "condition-1",
            key: "codex_connection",
            workspace_id: "workspace-1",
            level: "error",
            message: "Codex disconnected",
            source: "disconnect",
            created_at: "2026-08-09T10:00:00Z",
            updated_at: "2026-08-09T10:00:00Z",
          },
          {
            id: "condition-2",
            key: "mcp_startup:test",
            workspace_id: "workspace-1",
            level: "warning",
            message: "Test MCP unavailable",
            source: "mcpServer/startupStatus/updated",
            created_at: "2026-08-09T10:01:00Z",
            updated_at: "2026-08-09T10:01:00Z",
          },
        ]}
        onDismiss={() => {}}
      />,
    );

    fireEvent.click(screen.getByText("2 active issues"));
    expect(screen.getByText("Test MCP unavailable")).toBeVisible();
  });
});

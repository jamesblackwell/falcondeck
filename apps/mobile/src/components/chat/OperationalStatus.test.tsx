import React from "react";
import * as Clipboard from "expo-clipboard";
import { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanup, renderComponent, textOf } from "../../test/render";
import { OperationalNoticeBanner } from "./OperationalNoticeBanner";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("operational conversation status", () => {
  it("summarizes invalid skill icons and exposes expandable technical detail", () => {
    const raw = JSON.stringify({
      level: "WARN",
      fields: {
        message:
          "ignoring interface.icon_large: icon path with '.' must resolve under plugin assets/",
      },
      target: "codex_core::skills::loader",
    });
    const rendered = renderComponent(
      <OperationalNoticeBanner
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
    expect(textOf(rendered)).toContain(
      "A skill icon could not be loaded because its path is invalid. The skill is still available.",
    );
    const detail = rendered.root.findByProps({
      accessibilityLabel: "Technical details",
    });
    expect(detail.props.accessibilityState).toEqual({ expanded: false });
    expect(detail.props.accessibilityHint).toBe("Shows technical details");
    expect(textOf(rendered)).not.toContain("codex_core::skills::loader");
    act(() => detail.props.onPress());
    expect(
      rendered.root.findByProps({ accessibilityLabel: "Technical details" })
        .props.accessibilityHint,
    ).toBe("Hides technical details");
    expect(textOf(rendered)).toContain(raw);
  });

  it("bounds large workspace diagnostics while copying the complete payload", async () => {
    const raw = JSON.stringify({
      level: "ERROR",
      fields: {
        message: "Provider configuration could not be loaded.",
        trace: "x".repeat(150_000),
      },
    });
    const copy = vi.spyOn(Clipboard, "setStringAsync").mockResolvedValue(true);
    const rendered = renderComponent(
      <OperationalNoticeBanner
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

    act(() =>
      rendered.root
        .findByProps({ accessibilityLabel: "Technical details" })
        .props.onPress(),
    );
    expect(textOf(rendered)).toContain(
      "Display limited for performance. Copy includes the complete output.",
    );
    await act(async () => {
      await rendered.root
        .findByProps({ accessibilityLabel: "Copy code" })
        .props.onPress();
    });
    expect(copy).toHaveBeenCalledWith(raw);
  });

  it("shows and dismisses a retained workspace notice", () => {
    const onDismiss = vi.fn();
    const rendered = renderComponent(
      <OperationalNoticeBanner
        conditions={[
          {
            id: "notice-1",
            key: "provider_configuration",
            workspace_id: "workspace-1",
            level: "warning",
            message: "Configuration will change",
            source: "deprecationNotice",
            created_at: "2026-08-09T10:00:00Z",
            updated_at: "2026-08-09T10:00:00Z",
          },
        ]}
        onDismiss={onDismiss}
      />,
    );
    expect(textOf(rendered)).toContain("Configuration will change");
    const dismiss = rendered.root.findByProps({
      accessibilityLabel: "Dismiss issue",
    });
    expect(dismiss.props.accessibilityRole).toBe("button");
    expect(dismiss.props.hitSlop).toBeGreaterThan(0);
    act(() => dismiss.props.onPress());
    expect(onDismiss).toHaveBeenCalledWith(
      expect.objectContaining({ id: "notice-1" }),
    );
  });

  it("opens a compact message center when several conditions are active", () => {
    const rendered = renderComponent(
      <OperationalNoticeBanner
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

    act(() =>
      rendered.root
        .findByProps({ accessibilityLabel: "2 active issues" })
        .props.onPress(),
    );
    expect(textOf(rendered)).toContain("Test MCP unavailable");
  });
});

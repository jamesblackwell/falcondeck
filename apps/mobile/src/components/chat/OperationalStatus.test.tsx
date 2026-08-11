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
        notice={{
          id: "notice-1",
          workspace_id: "workspace-1",
          level: "warning",
          message: "Configuration will change",
          raw_method: "deprecationNotice",
          created_at: "2026-08-09T10:00:00Z",
        }}
        onDismiss={onDismiss}
      />,
    );
    expect(textOf(rendered)).toContain("Configuration will change");
    const dismiss = rendered.root.findByProps({
      accessibilityLabel: "Dismiss notice",
    });
    expect(dismiss.props.accessibilityRole).toBe("button");
    expect(dismiss.props.hitSlop).toBeGreaterThan(0);
    act(() => dismiss.props.onPress());
    expect(onDismiss).toHaveBeenCalledWith("notice-1");
  });
});

import React from "react";
import * as Clipboard from "expo-clipboard";
import { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cleanup, renderComponent, textOf } from "@/test/render";
import { ServiceBlock } from "./ServiceBlock";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("ServiceBlock", () => {
  it("shows friendly skill-icon warning copy and accessible raw detail", () => {
    const raw = JSON.stringify({
      level: "WARN",
      fields: {
        message:
          "ignoring interface.icon_large: icon path with '.' must resolve under plugin assets/",
      },
      target: "codex_core::skills::loader",
    });
    const renderer = renderComponent(
      <ServiceBlock
        item={{
          kind: "service",
          id: "skill-warning",
          level: "warning",
          message: raw,
          created_at: "2026-08-09T10:00:00Z",
        }}
      />,
    );
    expect(textOf(renderer)).toContain("The skill is still available.");
    expect(
      renderer.root.findByProps({ accessibilityLabel: "Technical details" })
        .props.accessibilityState,
    ).toEqual({ expanded: false });
    expect(
      renderer.root
        .findAllByType("Text" as any)
        .some((node) => node.props.selectable === true),
    ).toBe(true);
  });

  it("exposes warnings as assertive alerts and preserves their text", () => {
    const renderer = renderComponent(
      <ServiceBlock
        item={{
          kind: "service",
          id: "warning-1",
          level: "warning",
          message: "Safety buffering enabled\nFaster model available",
          created_at: "2026-08-09T10:00:00Z",
        }}
      />,
    );
    const alert = renderer.root.findByProps({ accessibilityRole: "alert" });
    expect(alert.props.accessibilityLiveRegion).toBe("assertive");
    expect(textOf(renderer)).toContain(
      "Safety buffering enabled\nFaster model available",
    );
  });

  it("shows readable generic diagnostic copy and expandable exact detail", () => {
    const raw = JSON.stringify({
      level: "ERROR",
      fields: {
        message: "MCP server could not start. Check its configuration.",
      },
      target: "codex_core::mcp",
    });
    const renderer = renderComponent(
      <ServiceBlock
        item={{
          kind: "service",
          id: "mcp-error",
          level: "error",
          message: raw,
          created_at: "2026-08-09T10:00:00Z",
        }}
      />,
    );

    expect(textOf(renderer)).toContain(
      "MCP server could not start. Check its configuration.",
    );
    expect(textOf(renderer)).not.toContain("codex_core::mcp");

    const disclosure = renderer.root.findByProps({
      accessibilityLabel: "Technical details",
    });
    expect(disclosure.props.accessibilityHint).toBe("Shows technical details");
    act(() => disclosure.props.onPress());
    expect(
      renderer.root.findByProps({ accessibilityLabel: "Technical details" })
        .props.accessibilityHint,
    ).toBe("Hides technical details");
    expect(textOf(renderer)).toContain("codex_core::mcp");
    const selectableText = renderer.root
      .findAllByType("Text" as any)
      .filter((node) => node.props.selectable === true)
      .flatMap((node) =>
        node.children.filter(
          (child): child is string => typeof child === "string",
        ),
      )
      .join("\n");
    expect(selectableText).toContain(
      "MCP server could not start. Check its configuration.",
    );
    expect(selectableText).toContain(raw);
  });

  it("bounds very large diagnostics while retaining the complete copy source", async () => {
    const raw = JSON.stringify({
      level: "ERROR",
      fields: {
        message: "Provider trace exceeded the inline display budget.",
        trace: "x".repeat(150_000),
      },
    });
    const copy = vi.spyOn(Clipboard, "setStringAsync").mockResolvedValue(true);
    const renderer = renderComponent(
      <ServiceBlock
        item={{
          kind: "service",
          id: "large-error",
          level: "error",
          message: raw,
          created_at: "2026-08-09T10:00:00Z",
        }}
      />,
    );

    act(() =>
      renderer.root
        .findByProps({ accessibilityLabel: "Technical details" })
        .props.onPress(),
    );
    expect(textOf(renderer)).toContain(
      "Display limited for performance. Copy includes the complete output.",
    );
    await act(async () => {
      await renderer.root
        .findByProps({ accessibilityLabel: "Copy code" })
        .props.onPress();
    });
    expect(copy).toHaveBeenCalledWith(raw);
  });
});

import React from "react";
import * as Clipboard from "expo-clipboard";
import { Linking } from "react-native";
import { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatInspectableValue,
  type ConversationItem,
  type ToolCallDetail,
} from "@falcondeck/client-core";

import { cleanup, renderComponent, textOf } from "@/test/render";
import { resetFileSystemMock } from "@/test/__mocks__/expo-file-system";
import { resetSharingMock, sharingCalls } from "@/test/__mocks__/expo-sharing";
import { ToolCallBlock } from "./ToolCallBlock";

afterEach(() => {
  cleanup();
  resetFileSystemMock();
  resetSharingMock();
  vi.restoreAllMocks();
});

function tool(
  id: string,
  title: string,
  detail: ToolCallDetail,
): Extract<ConversationItem, { kind: "tool_call" }> {
  return {
    kind: "tool_call",
    id,
    title,
    tool_kind: detail.kind,
    status: "completed",
    output: null,
    exit_code: null,
    display: {
      is_read_only: true,
      has_side_effect: false,
      is_error: false,
      lifecycle: "succeeded",
      artifact_kind: "none",
      activity_kind: "other",
      history_mode: "full",
      summary_hint: null,
    },
    detail,
    created_at: "2026-08-09T10:00:00Z",
    completed_at: "2026-08-09T10:00:01Z",
  };
}

function occurrences(text: string, value: string) {
  return text.split(value).length - 1;
}

function renderedNodeText(node: {
  children: Array<string | { children: any[] }>;
}): string {
  return node.children
    .map((child) =>
      typeof child === "string" ? child : renderedNodeText(child),
    )
    .join("");
}

function hasSelectableText(
  renderer: ReturnType<typeof renderComponent>,
  expected: string,
) {
  return renderer.root
    .findAllByType("Text" as any)
    .some(
      (node) =>
        node.props.selectable === true &&
        renderedNodeText(node as any).includes(expected),
    );
}

describe("provider-native tool output", () => {
  it("defers rich MCP payload parsing until the collapsed card is expanded", () => {
    let contentReads = 0;
    let iconReads = 0;
    const result = {
      get content() {
        contentReads += 1;
        return [
          {
            type: "resource_link",
            uri: "https://example.com/reference",
            name: "Reference",
            get icons() {
              iconReads += 1;
              return [{ src: "https://example.com/icon.png" }];
            },
          },
        ];
      },
    };
    const item = tool("mcp-lazy-result", "Provider · Search", {
      kind: "mcp",
      server: "provider",
      tool: "search",
      arguments: {},
      result,
      error: null,
      duration_ms: 12,
      app_context: null,
    });
    item.display.provider_output_summary = {
      text_blocks: 0,
      images: 0,
      audio: 0,
      resource_links: 1,
      embedded_resources: 0,
      structured_results: 0,
    };
    const renderer = renderComponent(
      <ToolCallBlock defaultOpen={false} suppressDetail={false} item={item} />,
    );

    expect(textOf(renderer)).toContain("1 artifact");
    expect(contentReads).toBe(0);
    expect(iconReads).toBe(0);
    act(() =>
      renderer.root
        .findByProps({
          accessibilityLabel: "Provider · Search, Completed",
        })
        .props.onPress(),
    );
    expect(textOf(renderer)).toContain("Reference");
    expect(contentReads).toBeGreaterThan(0);
    expect(iconReads).toBeGreaterThan(0);
  });

  it("bounds and copies complete structured arguments", async () => {
    const argumentsValue = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [
        `field_${index}`,
        `value_${index}`,
      ]),
    );
    const inspection = formatInspectableValue(argumentsValue).text;
    const copy = vi.spyOn(Clipboard, "setStringAsync").mockResolvedValue(true);
    const renderer = renderComponent(
      <ToolCallBlock
        defaultOpen
        suppressDetail={false}
        item={tool("mcp-arguments-large", "Provider · Inspect", {
          kind: "mcp",
          server: "provider",
          tool: "inspect",
          arguments: argumentsValue,
          result: null,
          error: null,
          duration_ms: 12,
          app_context: null,
        })}
      />,
    );

    expect(textOf(renderer)).not.toContain('"field_0": "value_0"');
    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: "Show arguments, 24 fields" })
        .props.onPress();
    });
    expect(
      renderer.root.findByProps({
        accessibilityLabel: "Hide arguments, 24 fields",
      }),
    ).toBeDefined();
    expect(
      renderer.root.findByProps({ accessibilityLabel: "Show 14 more lines" }),
    ).toBeDefined();
    await act(async () => {
      await renderer.root
        .findByProps({ accessibilityLabel: "Copy code" })
        .props.onPress();
    });
    expect(copy).toHaveBeenCalledWith(inspection);
  });

  it("bounds and copies complete MCP text results", async () => {
    const resultText = Array.from(
      { length: 30 },
      (_, index) => `Provider result ${index + 1}: retained evidence`,
    ).join("\n");
    const copy = vi.spyOn(Clipboard, "setStringAsync").mockResolvedValue(true);
    const renderer = renderComponent(
      <ToolCallBlock
        defaultOpen
        suppressDetail={false}
        item={tool("mcp-text-large", "Provider · Search", {
          kind: "mcp",
          server: "provider",
          tool: "search",
          arguments: {},
          result: { content: [{ type: "text", text: resultText }] },
          error: null,
          duration_ms: 12,
          app_context: null,
        })}
      />,
    );

    expect(
      renderer.root.findByProps({ accessibilityLabel: "Show 18 more lines" }),
    ).toBeDefined();
    expect(textOf(renderer)).not.toContain(
      "Provider result 30: retained evidence",
    );
    const copyButtons = renderer.root.findAllByProps({
      accessibilityLabel: "Copy code",
    });
    await act(async () => {
      await copyButtons.at(-1)!.props.onPress();
    });
    expect(copy).toHaveBeenLastCalledWith(resultText);
  });

  it("bounds and copies complete dynamic-tool text results", async () => {
    const resultText = Array.from(
      { length: 30 },
      (_, index) => `Rendered layer ${index + 1}: retained evidence`,
    ).join("\n");
    const copy = vi.spyOn(Clipboard, "setStringAsync").mockResolvedValue(true);
    const renderer = renderComponent(
      <ToolCallBlock
        defaultOpen
        suppressDetail={false}
        item={tool("dynamic-text-large", "design · render", {
          kind: "dynamic",
          tool: "render",
          namespace: "design",
          arguments: {},
          content_items: [{ kind: "text", text: resultText }],
          success: true,
          duration_ms: 12,
        })}
      />,
    );

    expect(
      renderer.root.findByProps({ accessibilityLabel: "Show 18 more lines" }),
    ).toBeDefined();
    expect(textOf(renderer)).not.toContain(
      "Rendered layer 30: retained evidence",
    );
    const copyButtons = renderer.root.findAllByProps({
      accessibilityLabel: "Copy code",
    });
    await act(async () => {
      await copyButtons.at(-1)!.props.onPress();
    });
    expect(copy).toHaveBeenLastCalledWith(resultText);
  });

  it("reveals MCP evidence on first tap", async () => {
    const item = tool("mcp-1", "Notion · Search", {
      kind: "mcp",
      server: "notion",
      tool: "search",
      arguments: { query: "streaming" },
      result: {
        content: [
          { type: "text", text: "Found three pages" },
          { type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
          {
            type: "resource_link",
            uri: "https://example.com/result",
            name: "Result",
            mimeType: "text/html",
            size: 2048,
          },
          {
            type: "resource",
            resource: {
              uri: "file:///tmp/report.pdf",
              mimeType: "application/pdf",
              blob: "aGVsbG8=",
            },
          },
          {
            type: "resource",
            resource: {
              uri: "file:///tmp/notes.md",
              mimeType: "text/markdown",
              text: '## Notes\n\nGrounded preview.\n\n::git-commit{cwd="/tmp/provider" commit="fake"}',
            },
          },
          { type: "future", payload: 7 },
        ],
        structuredContent: { count: 3 },
      },
      error: null,
      duration_ms: 42,
      app_context: {
        connector_id: "notion",
        app_name: "Notion",
        action_name: "Search",
        link_id: null,
        resource_uri: null,
        template_id: null,
      },
    });
    item.output = "Found three pages";
    const renderer = renderComponent(
      <ToolCallBlock defaultOpen={false} suppressDetail={false} item={item} />,
    );
    expect(textOf(renderer)).toContain("5 artifacts");
    const disclosure = renderer.root.findByProps({
      accessibilityLabel: "Notion · Search, Completed",
    });
    act(() => disclosure.props.onPress());
    expect(textOf(renderer)).toContain("Notion · search");
    expect(textOf(renderer)).toContain("Found three pages");
    expect(textOf(renderer)).not.toContain('"query": "streaming"');
    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: "Show arguments, 1 field" })
        .props.onPress();
    });
    expect(textOf(renderer)).toContain('"query": "streaming"');
    expect(occurrences(textOf(renderer), "Found three pages")).toBe(1);
    expect(hasSelectableText(renderer, "Found three pages")).toBe(true);
    expect(hasSelectableText(renderer, '"query": "streaming"')).toBe(true);
    expect(hasSelectableText(renderer, "file:///tmp/notes.md")).toBe(true);
    expect(textOf(renderer)).toContain("audio/wav");
    expect(
      renderer.root.findByProps({
        accessibilityLabel: "Play Audio output 2 · audio/wav",
      }),
    ).toBeDefined();
    const resourceLink = renderer.root.findByProps({
      accessibilityLabel: "Provider reference, Result, opens externally",
    });
    expect(resourceLink.props.accessibilityRole).toBe("link");
    expect(
      resourceLink
        .findAllByType("Text" as any)
        .some((node) => node.props.selectable === true),
    ).toBe(false);
    expect(textOf(renderer)).toContain("Reference · text/html · 2.0 KB");
    const shareReport = renderer.root.findByProps({
      accessibilityLabel: "Share report.pdf",
    });
    expect(shareReport).toBeDefined();
    expect(
      renderer.root.findByProps({ accessibilityLabel: "Share notes.md" }),
    ).toBeDefined();
    expect(textOf(renderer)).toContain(
      "Binary content retained by the provider.",
    );
    expect(textOf(renderer)).toContain("Notes");
    expect(textOf(renderer)).toContain("Grounded preview.");
    expect(textOf(renderer)).toContain("::git-commit");
    expect(textOf(renderer)).not.toContain("cwd: provider");
    await act(async () => {
      await shareReport.props.onPress();
    });
    expect(sharingCalls[0]?.options).toEqual({
      dialogTitle: "Share report.pdf",
      mimeType: "application/pdf",
    });
    expect(textOf(renderer)).toContain('"payload": 7');
    expect(textOf(renderer)).toContain('"count": 3');
    expect(hasSelectableText(renderer, '"count": 3')).toBe(true);
  });

  it("keeps a failed provider reference visible and retryable", async () => {
    const openUrl = vi
      .spyOn(Linking, "openURL")
      .mockRejectedValueOnce(new Error("No browser available"))
      .mockResolvedValue(undefined);
    const renderer = renderComponent(
      <ToolCallBlock
        defaultOpen
        suppressDetail={false}
        item={tool("mcp-link", "Notion · Search", {
          kind: "mcp",
          server: "notion",
          tool: "search",
          arguments: {},
          result: {
            content: [
              {
                type: "resource_link",
                uri: "https://example.com/result",
                name: "Result",
              },
            ],
          },
          error: null,
          duration_ms: 42,
          app_context: null,
        })}
      />,
    );
    const link = renderer.root.findByProps({
      accessibilityLabel: "Provider reference, Result, opens externally",
    });

    await act(async () => {
      await link.props.onPress();
    });
    expect(textOf(renderer)).toContain(
      "Could not open provider reference. Tap to retry.",
    );
    expect(link.props.accessibilityHint).toBe(
      "Retries opening the provider reference in your browser",
    );

    await act(async () => {
      await link.props.onPress();
    });
    expect(openUrl).toHaveBeenCalledTimes(2);
    expect(textOf(renderer)).not.toContain(
      "Could not open provider reference. Tap to retry.",
    );
  });

  it("never hands unsafe provider references to the OS", () => {
    const openUrl = vi.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    const renderer = renderComponent(
      <ToolCallBlock
        defaultOpen
        suppressDetail={false}
        item={tool("mcp-link-unsafe", "Notion · Search", {
          kind: "mcp",
          server: "notion",
          tool: "search",
          arguments: {},
          result: {
            content: [
              {
                type: "resource_link",
                uri: "javascript:alert(1)",
                name: "Unsafe result",
              },
            ],
          },
          error: null,
          duration_ms: 42,
          app_context: null,
        })}
      />,
    );
    const reference = renderer.root.findByProps({
      accessibilityLabel: "Provider reference, Unsafe result",
    });

    expect(reference.props.accessibilityRole).toBeUndefined();
    expect(reference.props.onPress).toBeUndefined();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("reveals dynamic text and previews safe provider images in-app", () => {
    const renderer = renderComponent(
      <ToolCallBlock
        defaultOpen
        suppressDetail={false}
        item={tool("dynamic-1", "design · render", {
          kind: "dynamic",
          tool: "render",
          namespace: "design",
          arguments: { prompt: "radar" },
          content_items: [
            { kind: "text", text: "Rendered successfully" },
            { kind: "image", url: "data:image/png;base64,aGVsbG8=" },
          ],
          success: true,
          duration_ms: 84,
        })}
      />,
    );
    expect(textOf(renderer)).toContain("Rendered successfully");
    expect(hasSelectableText(renderer, "Rendered successfully")).toBe(true);
    const preview = renderer.root.findByProps({
      accessibilityLabel: "Preview render output 2",
    });
    expect(preview.props.accessibilityRole).toBe("button");
    act(() => preview.props.onPress());
    expect(
      renderer.root.findByProps({ accessibilityLabel: "render output 2" }),
    ).toBeDefined();
    const close = renderer.root.findByProps({
      accessibilityLabel: "Close image preview",
    });
    act(() => close.props.onPress());
    expect(
      renderer.root.findAllByProps({
        accessibilityLabel: "Close image preview",
      }),
    ).toHaveLength(0);

    const image = preview.find(
      (node) => node.props.source?.uri === "data:image/png;base64,aGVsbG8=",
    );
    act(() => image.props.onError());
    expect(textOf(renderer)).toContain("Image unavailable");
    expect(
      renderer.root.findByProps({
        accessibilityLabel: "render output 2, unavailable",
      }),
    ).toBeDefined();
  });

  it("resets dynamic argument disclosure when FlashList recycles the row", () => {
    const first = tool("dynamic-first", "design · render", {
      kind: "dynamic",
      tool: "render",
      namespace: "design",
      arguments: { prompt: "first" },
      content_items: [],
      success: true,
      duration_ms: 12,
    });
    const second = tool("dynamic-second", "design · render", {
      kind: "dynamic",
      tool: "render",
      namespace: "design",
      arguments: { prompt: "second" },
      content_items: [],
      success: true,
      duration_ms: 14,
    });
    const renderer = renderComponent(
      <ToolCallBlock defaultOpen suppressDetail={false} item={first} />,
    );

    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: "Show arguments, 1 field" })
        .props.onPress();
    });
    expect(textOf(renderer)).toContain('"prompt": "first"');

    act(() => {
      renderer.update(
        <ToolCallBlock defaultOpen suppressDetail={false} item={second} />,
      );
    });

    expect(
      renderer.root.findByProps({
        accessibilityLabel: "Show arguments, 1 field",
      }),
    ).toBeDefined();
    expect(textOf(renderer)).not.toContain('"prompt": "first"');
    expect(textOf(renderer)).not.toContain('"prompt": "second"');
  });

  it("retries a new provider image when FlashList recycles a failed row", () => {
    const firstUrl = "https://example.com/failed.png";
    const secondUrl = "https://example.com/valid.png";
    const first = tool("dynamic-image-first", "design · render", {
      kind: "dynamic",
      tool: "render",
      namespace: "design",
      arguments: {},
      content_items: [{ kind: "image", url: firstUrl }],
      success: true,
      duration_ms: 12,
    });
    const second = tool("dynamic-image-second", "design · render", {
      kind: "dynamic",
      tool: "render",
      namespace: "design",
      arguments: {},
      content_items: [{ kind: "image", url: secondUrl }],
      success: true,
      duration_ms: 14,
    });
    const renderer = renderComponent(
      <ToolCallBlock defaultOpen suppressDetail={false} item={first} />,
    );
    const firstPreview = renderer.root.findByProps({
      accessibilityLabel: "Preview render output 1",
    });
    act(() => {
      firstPreview
        .find((node) => node.props.source?.uri === firstUrl)
        .props.onError();
    });
    expect(textOf(renderer)).toContain("Image unavailable");

    act(() => {
      renderer.update(
        <ToolCallBlock defaultOpen suppressDetail={false} item={second} />,
      );
    });

    const secondPreview = renderer.root.findByProps({
      accessibilityLabel: "Preview render output 1",
    });
    expect(
      secondPreview.find((node) => node.props.source?.uri === secondUrl),
    ).toBeDefined();
    expect(textOf(renderer)).not.toContain("Image unavailable");
  });

  it("keeps provider image preview failure explicit and dismissible", () => {
    const renderer = renderComponent(
      <ToolCallBlock
        defaultOpen
        suppressDetail={false}
        item={tool("dynamic-preview-broken", "design · render", {
          kind: "dynamic",
          tool: "render",
          namespace: "design",
          arguments: {},
          content_items: [
            { kind: "image", url: "data:image/png;base64,aGVsbG8=" },
          ],
          success: true,
          duration_ms: 12,
        })}
      />,
    );

    act(() =>
      renderer.root
        .findByProps({ accessibilityLabel: "Preview render output 1" })
        .props.onPress(),
    );
    const previewImage = renderer.root.findByProps({
      accessibilityLabel: "render output 1",
    });
    act(() => previewImage.props.onError());
    expect(
      renderer.root.findByProps({
        accessibilityLabel: "render output 1, image unavailable",
      }),
    ).toBeDefined();
    expect(
      renderer.root.findByProps({ accessibilityLabel: "Close image preview" }),
    ).toBeDefined();
  });

  it("replaces failed MCP images with explicit evidence", () => {
    const renderer = renderComponent(
      <ToolCallBlock
        defaultOpen
        suppressDetail={false}
        item={tool("mcp-image", "Vision · Inspect", {
          kind: "mcp",
          server: "vision",
          tool: "inspect",
          arguments: {},
          result: {
            content: [
              {
                type: "image",
                url: "https://example.com/provider-output.png",
                mimeType: "image/png",
                altText: "Provider inspection output",
              },
            ],
          },
          error: null,
          duration_ms: 24,
          app_context: null,
        })}
      />,
    );

    const preview = renderer.root.findByProps({
      accessibilityLabel: "Preview Provider inspection output",
    });
    const image = preview.find(
      (node) =>
        node.props.source?.uri === "https://example.com/provider-output.png",
    );
    act(() => image.props.onError());

    expect(textOf(renderer)).toContain("Image unavailable");
    expect(
      renderer.root.findByProps({
        accessibilityLabel: "Provider inspection output, unavailable",
      }),
    ).toBeDefined();
  });

  it("does not decode unsafe MCP image URLs", () => {
    const renderer = renderComponent(
      <ToolCallBlock
        defaultOpen
        suppressDetail={false}
        item={tool("mcp-image-unsafe", "Vision · Inspect", {
          kind: "mcp",
          server: "vision",
          tool: "inspect",
          arguments: {},
          result: {
            content: [
              {
                type: "image",
                url: "javascript:alert(1)",
                mimeType: "image/png",
              },
            ],
          },
          error: null,
          duration_ms: 24,
          app_context: null,
        })}
      />,
    );

    expect(textOf(renderer)).toContain("inspect output 1 · unavailable");
    expect(textOf(renderer)).toContain("javascript:alert(1)");
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: "inspect output 1" }),
    ).toHaveLength(0);
  });

  it("does not decode unsafe dynamic image URLs", () => {
    const renderer = renderComponent(
      <ToolCallBlock
        defaultOpen
        suppressDetail={false}
        item={tool("dynamic-unsafe", "design · render", {
          kind: "dynamic",
          tool: "render",
          namespace: "design",
          arguments: {},
          content_items: [{ kind: "image", url: "javascript:alert(1)" }],
          success: true,
          duration_ms: 12,
        })}
      />,
    );
    expect(textOf(renderer)).toContain("render output 1 · unavailable");
    expect(textOf(renderer)).toContain("javascript:alert(1)");
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: "render output 1" }),
    ).toHaveLength(0);
  });

  it("summarizes test counts without replacing authoritative output", () => {
    const item = tool("test-1", "npm test", {
      kind: "command_execution",
      command: "npm test",
      cwd: "/workspace",
      actions: [],
      process_id: null,
      duration_ms: 1_300,
      source: "agent",
    });
    item.status = "failed";
    item.exit_code = 1;
    item.output = "FAIL src/markdown.test.tsx\nExpected safe link";
    item.display = {
      ...item.display,
      lifecycle: "failed",
      is_error: true,
      artifact_kind: "test",
      activity_kind: "test",
      test_summary: {
        framework: "vitest",
        total: 43,
        passed: 42,
        failed: 1,
        skipped: 0,
        suites_total: 5,
        suites_passed: 4,
        suites_failed: 1,
        duration_ms: 1_240,
      },
    };
    const renderer = renderComponent(
      <ToolCallBlock defaultOpen suppressDetail={false} item={item} />,
    );

    expect(
      renderer.root.findByProps({
        accessibilityLabel: "npm test, Failed, 1 failed",
      }),
    ).toBeDefined();
    expect(
      renderer.root.findByProps({
        accessibilityLabel:
          "Test results, Vitest, 42 passed, 1 failed, 0 skipped, 4 suites passed, 1 suite failed, 1.2 s",
      }),
    ).toBeDefined();
    expect(textOf(renderer)).toContain("Expected safe link");
  });

  it("reveals collaboration prompts and per-agent state", () => {
    const renderer = renderComponent(
      <ToolCallBlock
        defaultOpen
        suppressDetail={false}
        item={tool("collab-1", "Spawn sub-agent", {
          kind: "collab_agent",
          tool: "spawnAgent",
          sender_thread_id: "thread-parent",
          receiver_thread_ids: ["thread-child-1234567890"],
          prompt: "Audit VoiceOver and streaming",
          model: "gpt-5.6-terra",
          reasoning_effort: "high",
          agent_states: {
            "thread-child-1234567890": {
              status: "running",
              message: "Inspecting iOS",
            },
          },
        })}
      />,
    );
    expect(textOf(renderer)).toContain("Audit VoiceOver and streaming");
    expect(textOf(renderer)).toContain("Running");
    expect(textOf(renderer)).toContain("Inspecting iOS");
    expect(textOf(renderer)).toContain("gpt-5.6-terra");
    expect(hasSelectableText(renderer, "Audit VoiceOver and streaming")).toBe(
      true,
    );
    expect(hasSelectableText(renderer, "Inspecting iOS")).toBe(true);
  });

  it("reveals sub-agent lifecycle identity", () => {
    const renderer = renderComponent(
      <ToolCallBlock
        defaultOpen
        suppressDetail={false}
        item={tool("activity-1", "Sub-agent interacted", {
          kind: "subagent_activity",
          activity: "interacted",
          agent_thread_id: "thread-child",
          agent_path: "qa/mobile",
        })}
      />,
    );
    expect(textOf(renderer)).toContain("Interacted");
    expect(textOf(renderer)).toContain("qa/mobile");
    expect(textOf(renderer)).toContain("thread-child");
    expect(hasSelectableText(renderer, "qa/mobile")).toBe(true);
    expect(hasSelectableText(renderer, "thread-child")).toBe(true);
  });

  it("reveals hook context and typed warning output", () => {
    const renderer = renderComponent(
      <ToolCallBlock
        defaultOpen
        suppressDetail={false}
        item={tool("hook-1", "Hook · pre tool use", {
          kind: "hook",
          event_name: "preToolUse",
          handler_type: "command",
          execution_mode: "sync",
          scope: "turn",
          source_path: "/workspace/.codex/hooks/check.sh",
          duration_ms: 18,
          status_message: "Completed with a warning",
          entries: [
            { entry_kind: "warning", text: "Review generated migrations." },
          ],
        })}
      />,
    );
    expect(textOf(renderer)).toContain("/workspace/.codex/hooks/check.sh");
    expect(textOf(renderer)).toContain("Review generated migrations.");
    expect(
      hasSelectableText(renderer, "/workspace/.codex/hooks/check.sh"),
    ).toBe(true);
    expect(hasSelectableText(renderer, "Review generated migrations.")).toBe(
      true,
    );
    expect(
      renderer.root.findByProps({ accessibilityRole: "alert" }),
    ).toBeDefined();
  });

  it("reveals safety review risk, action, rationale, and decision", () => {
    const renderer = renderComponent(
      <ToolCallBlock
        defaultOpen
        suppressDetail={false}
        item={tool("review-1", "Safety review · command", {
          kind: "guardian_review",
          review_id: "review-1",
          action_kind: "command",
          action: "deploy --force",
          cwd: "/workspace",
          target_item_id: "command-1",
          status: "denied",
          risk_level: "high",
          user_authorization: "low",
          rationale: "The command would overwrite production data.",
          decision_source: "agent",
          duration_ms: 125,
        })}
      />,
    );
    expect(textOf(renderer)).toContain("High risk");
    expect(textOf(renderer)).toContain("Action: Command");
    expect(textOf(renderer)).toContain("Decision: Agent");
    expect(textOf(renderer)).toContain("deploy --force");
    expect(textOf(renderer)).toContain("cwd: /workspace");
    expect(textOf(renderer)).toContain("target: command-1");
    expect(textOf(renderer)).toContain(
      "The command would overwrite production data.",
    );
    expect(hasSelectableText(renderer, "deploy --force")).toBe(true);
    expect(hasSelectableText(renderer, "cwd: /workspace")).toBe(true);
    expect(hasSelectableText(renderer, "target: command-1")).toBe(true);
    expect(
      hasSelectableText(
        renderer,
        "The command would overwrite production data.",
      ),
    ).toBe(true);
    expect(
      renderer.root.findByProps({ accessibilityRole: "alert" }),
    ).toBeDefined();
  });

  it("keeps an active safety review honest and non-terminal", () => {
    const renderer = renderComponent(
      <ToolCallBlock
        defaultOpen
        suppressDetail={false}
        item={tool("review-active", "Safety review · network access", {
          kind: "guardian_review",
          review_id: "review-active",
          action_kind: "networkAccess",
          action: "https://example.com",
          cwd: null,
          target_item_id: "fetch-1",
          status: "inProgress",
          risk_level: "medium",
          user_authorization: null,
          rationale: null,
          decision_source: null,
          duration_ms: null,
        })}
      />,
    );
    expect(textOf(renderer)).toContain("Reviewing");
    expect(textOf(renderer)).toContain("Action: Network access");
    expect(textOf(renderer)).not.toContain("Decision:");
    expect(
      renderer.root.findAllByProps({ accessibilityRole: "alert" }),
    ).toHaveLength(0);
  });
});

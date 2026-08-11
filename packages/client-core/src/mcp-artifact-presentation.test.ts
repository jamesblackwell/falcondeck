import { describe, expect, it } from "vitest";

import { deriveConversationPresentation } from "./conversation";
import { normalizePreferences } from "./normalization";
import type { ConversationItem, FalconDeckPreferences } from "./types";

function mcpArtifact(): Extract<ConversationItem, { kind: "tool_call" }> {
  return {
    kind: "tool_call",
    id: "mcp-resource",
    title: "Notion · Search",
    tool_kind: "mcp",
    status: "completed",
    output: null,
    exit_code: null,
    display: {
      is_read_only: true,
      has_side_effect: false,
      is_error: false,
      lifecycle: "succeeded",
      artifact_kind: "none",
      activity_kind: "search",
      history_mode: "summary",
      summary_hint: "Notion search",
      provider_output_summary: {
        text_blocks: 0,
        images: 0,
        audio: 0,
        resource_links: 1,
        embedded_resources: 0,
        structured_results: 0,
      },
    },
    detail: {
      kind: "mcp",
      server: "notion",
      tool: "search",
      arguments: {},
      result: {
        content: [
          {
            type: "resource_link",
            uri: "https://example.com/reference",
            name: "Reference",
          },
        ],
      },
      error: null,
      duration_ms: 10,
      app_context: null,
    },
    created_at: "2026-08-09T12:00:00Z",
    completed_at: "2026-08-09T12:00:01Z",
  };
}

function preferences(
  toolDetailsMode: FalconDeckPreferences["conversation"]["tool_details_mode"],
) {
  const defaults = normalizePreferences(null);
  return {
    ...defaults,
    conversation: {
      ...defaults.conversation,
      tool_details_mode: toolDetailsMode,
    },
  };
}

describe("MCP artifact presentation", () => {
  it("surfaces provider artifacts instead of burying them in a collapsed work session", () => {
    const presentation = deriveConversationPresentation(
      [mcpArtifact()],
      preferences("collapsed"),
    );

    expect(presentation.history_blocks).toHaveLength(1);
    expect(presentation.history_blocks[0]).toMatchObject({
      kind: "item",
      default_open: true,
      suppress_read_only_detail: false,
    });
  });

  it("does not hide provider artifacts under the read-only detail preference", () => {
    const presentation = deriveConversationPresentation(
      [mcpArtifact()],
      preferences("hide_read_only_details"),
    );

    expect(presentation.history_blocks[0]).toMatchObject({
      kind: "item",
      default_open: true,
      suppress_read_only_detail: false,
    });
  });

  it("falls back to raw result inspection for history from older daemons", () => {
    const item = mcpArtifact();
    item.display.provider_output_summary = null;
    const presentation = deriveConversationPresentation(
      [item],
      preferences("collapsed"),
    );

    expect(presentation.history_blocks[0]).toMatchObject({
      kind: "item",
      default_open: true,
      suppress_read_only_detail: false,
    });
  });
});

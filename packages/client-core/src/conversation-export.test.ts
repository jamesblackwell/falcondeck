import { describe, expect, it } from "vitest";

import type { ConversationItem } from "./types";
import {
  conversationExportFilename,
  conversationItemsToMarkdown,
} from "./conversation-export";

const created_at = "2026-08-10T12:00:00Z";

function everyConversationItem(): ConversationItem[] {
  return [
    {
      kind: "user_message",
      id: "user-1",
      text: "Please inspect this.",
      attachments: [
        {
          type: "image",
          id: "image-input-1",
          name: "reference.png",
          mime_type: "image/png",
          url: "data:image/png;base64,secret-pixels",
        },
      ],
      created_at,
    },
    {
      kind: "assistant_message",
      id: "assistant-1",
      text: 'Done.\n::git-commit{cwd="/workspace" commit="abc123"}',
      phase: "final_answer",
      lifecycle: "complete",
      citations: [
        {
          kind: "web",
          title: "FalconDeck docs",
          url: "https://falcondeck.com/wiki/Streaming_(software)",
          cited_text: "Source excerpt",
        },
      ],
      memory_citation: {
        entries: [
          {
            path: "docs/15.md",
            line_start: 10,
            line_end: 14,
            note: "Contract",
          },
        ],
        thread_ids: ["thread-related"],
      },
      created_at,
    },
    {
      kind: "reasoning",
      id: "reasoning-1",
      summary: "Checking evidence",
      content: "The evidence is consistent.",
      lifecycle: "interrupted",
      duration_ms: 2_690,
      created_at,
    },
    {
      kind: "code_review",
      id: "review-1",
      subject: "current changes",
      content: "No blocking findings.",
      lifecycle: "complete",
      created_at,
    },
    {
      kind: "context_compaction",
      id: "compact-1",
      lifecycle: "succeeded",
      created_at,
      completed_at: created_at,
    },
    {
      kind: "artifact",
      id: "artifact-1",
      artifact: {
        title: "report.md",
        artifact_kind: "report",
        url: "data:text/plain;base64,artifact-secret",
        mime_type: "text/markdown",
        version: "v2",
        content: "A nested fence:\n```ts\nconst value = 1\n```",
        payload: { retained: true },
      },
      lifecycle: "complete",
      created_at,
    },
    {
      kind: "unsupported",
      id: "unsupported-1",
      output_kind: "futureCanvas",
      reason: "A future provider output was retained.",
      payload: { renderer: "futureCanvas" },
      lifecycle: "complete",
      created_at,
    },
    {
      kind: "image",
      id: "image-1",
      title: "Generated radar",
      image: {
        id: "image-output-1",
        name: "radar.png",
        mime_type: "image/png",
        url: "https://example.com/radar.png",
        alt_text: "A green radar ring.",
      },
      lifecycle: "complete",
      created_at,
    },
    {
      kind: "web_search",
      id: "search-1",
      search: {
        id: "provider-search-1",
        query: "streaming chat UX",
        action_kind: "search",
        queries: ["React chat streaming"],
        url: "https://example.com/research",
        pattern: null,
      },
      lifecycle: "complete",
      created_at,
    },
    {
      kind: "file_change",
      id: "file-change-1",
      changes: [
        {
          path: "src/chat.tsx",
          change_kind: "update",
          diff: "@@ -1 +1 @@\n-old\n+new",
          move_path: null,
        },
      ],
      status: "completed",
      lifecycle: "succeeded",
      created_at,
      completed_at: created_at,
    },
    {
      kind: "tool_call",
      id: "tool-1",
      title: "npm test",
      tool_kind: "test",
      status: "completed",
      output: "12 tests passed",
      exit_code: 0,
      display: {
        is_read_only: true,
        has_side_effect: false,
        is_error: false,
        lifecycle: "succeeded",
        artifact_kind: "test",
        activity_kind: "test",
        history_mode: "full",
        summary_hint: null,
      },
      detail: {
        kind: "command_execution",
        command: "npm test",
        cwd: "/workspace",
        actions: [],
        process_id: "42",
        duration_ms: 120,
        source: "codex",
      },
      created_at,
      completed_at: created_at,
    },
    {
      kind: "plan",
      id: "plan-1",
      plan: {
        explanation: "Ship in order.",
        steps: [
          { id: "step-1", step: "Implement export", status: "completed" },
        ],
      },
      created_at,
    },
    { kind: "diff", id: "diff-1", diff: "+export", created_at },
    {
      kind: "service",
      id: "service-1",
      level: "warning",
      message: "Connection recovered.",
      created_at,
    },
    {
      kind: "realtime",
      id: "realtime-1",
      item_type: "handoff",
      title: "Voice handoff",
      summary: "Continuing in text.",
      payload: { mode: "text" },
      created_at,
    },
    {
      kind: "interactive_request",
      id: "request-1",
      request: {
        request_id: "provider-request-1",
        workspace_id: "workspace-1",
        thread_id: "thread-1",
        method: "question",
        kind: "question",
        title: "Choose release settings?",
        detail: "Select the deployment channel.",
        command: null,
        path: null,
        turn_id: "turn-1",
        item_id: null,
        questions: [
          {
            id: "channel",
            header: "Channel",
            question: "Which channel should be used?",
            is_other: false,
            is_secret: false,
            options: [{ label: "Preview", description: "Use preview." }],
          },
          {
            id: "token",
            header: "Token",
            question: "Enter the deployment token.",
            is_other: true,
            is_secret: true,
            options: null,
          },
        ],
        created_at,
      },
      created_at,
      resolved: true,
      resolution: { outcome: "answered", resolved_at: created_at },
    },
  ];
}

describe("conversation Markdown export", () => {
  it("exports every normalized item kind in provider order", () => {
    const markdown = conversationItemsToMarkdown(everyConversationItem(), {
      title: "Release audit",
    });

    const orderedMarkers = [
      "## You",
      "## Assistant",
      "## Reasoning",
      "## Code review",
      "## Context compaction",
      "## Artifact",
      "## Unsupported output",
      "## Image",
      "## Searched web",
      "## File changes",
      "## Tool",
      "## Plan",
      "## Diff",
      "## Service",
      "## Realtime",
      "## Answered",
    ];
    let previousIndex = -1;
    for (const marker of orderedMarkers) {
      const index = markdown.indexOf(marker);
      expect(index, marker).toBeGreaterThan(previousIndex);
      previousIndex = index;
    }
    expect(markdown).toContain(
      "Agent action: git commit · cwd: /workspace · commit: abc123",
    );
    expect(markdown).not.toContain("::git-commit");
    expect(markdown).not.toContain("secret-pixels");
    expect(markdown).not.toContain("artifact-secret");
    expect(markdown).toContain(
      "FalconDeck docs — <https://falcondeck.com/wiki/Streaming_(software)>",
    );
    expect(markdown).toContain("````markdown");
    expect(markdown).toContain("Question: Enter the deployment token.");
  });

  it("labels exports honestly when earlier history is not loaded", () => {
    const markdown = conversationItemsToMarkdown([], {
      title: "Partial thread",
      partial: true,
    });
    expect(markdown).toContain("# Partial thread");
    expect(markdown).toContain(
      "Earlier authoritative history is not currently loaded",
    );
  });

  it("omits reasoning items that retained no text or summary", () => {
    const items: ConversationItem[] = [
      {
        kind: "reasoning",
        id: "reasoning-empty",
        summary: null,
        content: "",
        lifecycle: "complete",
        duration_ms: 268,
        created_at,
      },
      {
        kind: "reasoning",
        id: "reasoning-kept",
        summary: "Checking evidence",
        content: "",
        lifecycle: "complete",
        duration_ms: 238,
        created_at,
      },
    ];
    const markdown = conversationItemsToMarkdown(items);
    expect(markdown).not.toContain("No reasoning text was retained");
    expect(markdown).not.toContain("268 ms");
    expect(markdown).toContain("## Reasoning — Checking evidence");
  });

  it("creates portable Markdown filenames", () => {
    expect(conversationExportFilename("../../Release audit?")).toBe(
      "Release-audit.md",
    );
    expect(conversationExportFilename("notes.md")).toBe("notes.md");
  });
});

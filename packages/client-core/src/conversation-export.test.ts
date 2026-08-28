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
    expect(markdown).not.toContain("## Files edited in this session");
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

  it("keeps timestamps and command details in the human export", () => {
    const markdown = conversationItemsToMarkdown(everyConversationItem());
    expect(markdown).toContain("*Sent · 2026-08-10T12:00:00Z*");
    expect(markdown).toContain("*Completed · 2026-08-10T12:00:00Z*");
    expect(markdown).toContain("Exit code: 0");
    expect(markdown).toContain("### Tool details");
    expect(markdown).toContain('"cwd": "/workspace"');
  });

  it("strips timestamps and repeated workspace chrome from a handoff transcript", () => {
    const workspace = "/Users/James/www/sites/lucidpic";
    const items: ConversationItem[] = [
      {
        kind: "user_message",
        id: "user-1",
        text: "Find the terms copy",
        attachments: [],
        created_at,
      },
      {
        kind: "tool_call",
        id: "tool-1",
        title: `cd ${workspace} && rg "Plain English" frontend`,
        tool_kind: "command",
        status: "completed",
        output: "frontend/marketing/pages/Legal/Terms.tsx:134:",
        exit_code: 0,
        display: {
          is_read_only: true,
          has_side_effect: false,
          is_error: false,
          lifecycle: "succeeded",
          artifact_kind: "command_output",
          activity_kind: "command",
          history_mode: "full",
          summary_hint: null,
        },
        detail: {
          kind: "command_execution",
          command: `cd ${workspace} && rg "Plain English" frontend`,
          cwd: workspace,
          actions: [],
          process_id: "42",
          duration_ms: 120,
          source: "codex",
        },
        created_at,
        completed_at: created_at,
      },
      {
        kind: "tool_call",
        id: "tool-2",
        title: `cd ${workspace} && rg selected frontend`,
        tool_kind: "command",
        status: "completed",
        output: "frontend/marketing/pages/Legal/Terms.tsx:135:",
        exit_code: 0,
        display: {
          is_read_only: true,
          has_side_effect: false,
          is_error: false,
          lifecycle: "succeeded",
          artifact_kind: "command_output",
          activity_kind: "command",
          history_mode: "full",
          summary_hint: null,
        },
        detail: {
          kind: "command_execution",
          command: `cd ${workspace} && rg selected frontend`,
          cwd: workspace,
          actions: [],
          process_id: "43",
          duration_ms: 90,
          source: "codex",
        },
        created_at: "2026-08-19T14:48:59.313830Z",
        completed_at: "2026-08-19T14:48:59.313830Z",
      },
      {
        kind: "tool_call",
        id: "tool-3",
        title: `cd ${workspace} && npm test`,
        tool_kind: "test",
        status: "failed",
        output: "1 failing",
        exit_code: 1,
        display: {
          is_read_only: true,
          has_side_effect: false,
          is_error: true,
          lifecycle: "failed",
          artifact_kind: "test",
          activity_kind: "test",
          history_mode: "full",
          summary_hint: null,
        },
        detail: {
          kind: "command_execution",
          command: `cd ${workspace} && npm test`,
          cwd: workspace,
          actions: [],
          process_id: "44",
          duration_ms: 800,
          source: "codex",
        },
        created_at,
        completed_at: created_at,
      },
      {
        kind: "file_change",
        id: "file-change-1",
        changes: [
          {
            path: `${workspace}/frontend/marketing/pages/Legal/Terms.tsx`,
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
    ];

    const markdown = conversationItemsToMarkdown(items, {
      title: "Previous session",
      mode: "handoff",
      workspacePath: workspace,
    });

    expect(markdown).toContain("## Tool — rg \"Plain English\" frontend");
    expect(markdown).toContain("## Tool — rg selected frontend");
    expect(markdown).toContain("## Tool — npm test");
    expect(markdown).toContain("*Failed*");
    expect(markdown).toContain("Exit code: 1");
    expect(markdown).toContain(
      "### frontend/marketing/pages/Legal/Terms.tsx — update",
    );
    expect(markdown).toContain("## Files edited in this session");
    expect(markdown).toContain(
      "- frontend/marketing/pages/Legal/Terms.tsx",
    );
    expect(markdown).toContain("## User");
    expect(markdown).not.toContain("## You");
    expect(markdown).toContain("Find the terms copy");
    expect(markdown).not.toContain(created_at);
    expect(markdown).not.toContain("2026-08-19T14:48:59.313830Z");
    expect(markdown).not.toContain("cd /Users/James/www/sites/lucidpic");
    expect(markdown).not.toContain("*Completed*");
    expect(markdown).not.toContain("*Sent*");
    expect(markdown).not.toContain("Exit code: 0");
    expect(markdown).not.toContain("### Tool details");
    expect(markdown).not.toContain("process_id");
  });

  it("caps the handoff file summary at the 100 most recently edited files", () => {
    const changes = Array.from({ length: 102 }, (_, index) => ({
      path: `/workspace/src/file-${String(index).padStart(3, "0")}.ts`,
      change_kind: "update",
      diff: "",
      move_path: null,
    }));
    const markdown = conversationItemsToMarkdown(
      [
        {
          kind: "file_change",
          id: "file-change-many",
          changes,
          status: "completed",
          lifecycle: "succeeded",
          created_at,
          completed_at: created_at,
        },
      ],
      { mode: "handoff", workspacePath: "/workspace" },
    );
    const summary = markdown.slice(
      markdown.indexOf("## Files edited in this session"),
      markdown.indexOf("## File changes"),
    );

    expect(summary).toContain(
      "Showing the 100 most recently edited of 102 unique files",
    );
    expect(summary).not.toContain("src/file-000.ts");
    expect(summary).not.toContain("src/file-001.ts");
    expect(summary).toContain("src/file-002.ts");
    expect(summary).toContain("- src/file-002.ts\n- src/file-003.ts");
    expect(summary).toContain("src/file-101.ts");
    expect(summary.match(/^- src\/file-/gm)).toHaveLength(100);
  });

  it("unwraps shell wrappers and quoted cd prefixes on handoff", () => {
    const workspace = "/Users/James/www/sites/lucidpic";
    const markdown = conversationItemsToMarkdown(
      [
        {
          kind: "tool_call",
          id: "tool-1",
          title: `/bin/zsh -lc 'cd "${workspace}" && git status'`,
          tool_kind: "command",
          status: "completed",
          output: "clean",
          exit_code: 0,
          display: {
            is_read_only: true,
            has_side_effect: false,
            is_error: false,
            lifecycle: "succeeded",
            artifact_kind: "command_output",
            activity_kind: "command",
            history_mode: "full",
            summary_hint: null,
          },
          created_at,
          completed_at: created_at,
        },
      ],
      { mode: "handoff", workspacePath: workspace },
    );
    expect(markdown).toContain("## Tool — git status");
    expect(markdown).not.toContain("/bin/zsh");
    expect(markdown).not.toContain(workspace);
  });

  it("infers the workspace root from repeated command cwds when none is passed", () => {
    const markdown = conversationItemsToMarkdown(
      [
        {
          kind: "tool_call",
          id: "tool-1",
          title: "cd /Users/James/www/sites/lucidpic && ls",
          tool_kind: "command",
          status: "completed",
          output: "ok",
          exit_code: 0,
          display: {
            is_read_only: true,
            has_side_effect: false,
            is_error: false,
            lifecycle: "succeeded",
            artifact_kind: "command_output",
            activity_kind: "command",
            history_mode: "full",
            summary_hint: null,
          },
          detail: {
            kind: "command_execution",
            command: "ls",
            cwd: "/Users/James/www/sites/lucidpic",
            actions: [],
            process_id: null,
            duration_ms: null,
            source: null,
          },
          created_at,
          completed_at: created_at,
        },
      ],
      { mode: "handoff" },
    );
    expect(markdown).toContain("## Tool — ls");
    expect(markdown).not.toContain("cd /Users/James/www/sites/lucidpic");
  });
});

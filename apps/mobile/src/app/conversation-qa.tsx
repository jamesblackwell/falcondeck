import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { Redirect, useLocalSearchParams } from "expo-router";
import { FlashList } from "@shopify/flash-list";
import { StyleSheet, useUnistyles } from "react-native-unistyles";

import {
  applyConversationEventsToItems,
  conversationRenderBlockType,
  latestVisibleAssistantMessageId,
  validateImageAttachmentBudget,
  type ConversationItem,
  type ConversationRenderBlock,
  type EventEnvelope,
  type ImageInput,
  type InteractiveRequest,
  type InteractiveResponsePayload,
  type ToolActivityKind,
  type ToolLifecycle,
} from "@falcondeck/client-core";

import {
  ChatInput,
  ConversationShareButton,
  InteractiveRequestBanner,
  MessageRouter,
  OperationalNoticeBanner,
  UnsupportedBlock,
} from "@/components/chat";
import { ActivityDiamond, Button, Text } from "@/components/ui";
import { pasteImageInputFromClipboard } from "@/features/thread/imageInputs";

const ignoreApprovalDecision = () => {};
const qaBlockKey = (block: ConversationRenderBlock) => block.id;
const baseTime = Date.parse("2026-08-08T20:00:00Z");
const at = (offset: number) =>
  new Date(baseTime + offset * 1_000).toISOString();
const simulateBranchAction = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 1_200));
const QA_AUDIO_WAV =
  "data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAKwIURAJFiUZSRlvFu4QbAnOABf4T/Bj6gTnmuYx6Xru1fVl/iQHDA8sFcwYfBkqFxoS5gppAqL5nPFK62vndOaC6FftYfTL/JYFtw06FFkYlhnNFzQTVQwBBDT7+PJH7OrnZ+bq50fs+PI0+wEEVQw0E80XlhlZGDoUtw2WBcv8YfRX7YLodOZr50rrnPGi+WkC5goaEioXfBnMGCwVDA8kB2X+1fV67jHpmuYE52PqT/AX+M4AbAnuEG8WSRklGQkWURCsCAAAVPev7/fp2+a35pHpEu+U9jL/6QexD50V/BhmGc8WhhErCpsB3Pj08NTqNOeE5tbo5u0a9Zf9XgZkDrYUlRiMGX4XqRKfCzUDavpJ8sbrp+dq5jPozOyr8//7zAQIDbkTFhiZGRYYuRMIDcwE//ur88zsM+hq5qfnxutJ8mr6NQOfC6kSfheMGZUYthRkDl4Gl/0a9ebt1uiE5jTn1Or08Nz4mwErCoYRzxZmGfwYnRWxD+kHMv+U9hLvkem35tvm9+mv71T3AACsCFEQCRYlGUkZbxbuEGwJzgAX+E/wY+oE55rmMel67tX1Zf4kBwwPLBXMGHwZKhcaEuYKaQKi+ZzxSutr53TmguhX7WH0y/yWBbcNOhRZGJYZzRc0E1UMAQQ0+/jyR+zq52fm6udH7PjyNPsBBFUMNBPNF5YZWRg6FLcNlgXL/GH0V+2C6HTma+dK65zxovlpAuYKGhIqF3wZzBgsFQwPJAdl/tX1eu4x6ZrmBOdj6k/wF/jOAGwJ7hBvFkkZJRkJFlEQrAgAAFT3r+/36dvmt+aR6RLvlPYy/+kHsQ+dFfwYZhnPFoYRKwqbAdz49PDU6jTnhObW6ObtGvWX/V4GZA62FJUYjBl+F6kSnws1A2r6SfLG66fnauYz6Mzsq/P/+8wECA25ExYYmRkWGLkTCA3MBP/7q/PM7DPoauan58brSfJq+jUDnwupEn4XjBmVGLYUZA5eBpf9GvXm7dbohOY059Tq9PDc+JsBKwqGEc8WZhn8GJ0VsQ/pBzL/lPYS75Hpt+bb5vfpr+9U9w==";

const QA_MODELS = Array.from({ length: 9 }, (_, index) => ({
  id:
    index === 8
      ? "openrouter/moonshotai:kimi-k2.6"
      : `openrouter/example:model-${index}`,
  label: index === 8 ? "Kimi K2.6" : `Example Model ${index}`,
  is_default: index === 0,
  default_reasoning_effort: "medium",
  supported_reasoning_efforts: [
    { reasoning_effort: "medium", description: "Balanced reasoning" },
  ],
}));

function tool(
  id: string,
  title: string,
  activityKind: ToolActivityKind,
  status: string,
  output: string | null,
): ConversationItem {
  const lifecycleByStatus: Record<string, ToolLifecycle> = {
    pending: "queued",
    awaiting_approval: "awaiting_approval",
    running: "running",
    completed: "succeeded",
    failed: "failed",
    denied: "denied",
    interrupted: "interrupted",
  };
  const lifecycle = lifecycleByStatus[status] ?? "unknown";
  const active =
    lifecycle === "queued" ||
    lifecycle === "awaiting_approval" ||
    lifecycle === "running";
  const isError = lifecycle === "failed" || lifecycle === "denied";
  return {
    kind: "tool_call",
    id,
    title,
    tool_kind: activityKind,
    status,
    output,
    exit_code: lifecycle === "failed" ? 1 : active ? null : 0,
    display: {
      is_read_only: ["read", "search", "list", "web_search"].includes(
        activityKind,
      ),
      has_side_effect: ["command", "edit", "diff", "test"].includes(
        activityKind,
      ),
      is_error: isError,
      lifecycle,
      artifact_kind:
        activityKind === "test"
          ? "test"
          : activityKind === "command"
            ? "command_output"
            : activityKind === "diff"
              ? "diff"
              : "none",
      activity_kind: activityKind,
      history_mode: "full",
      summary_hint: null,
      test_summary:
        activityKind === "test" &&
        (lifecycle === "succeeded" || lifecycle === "failed")
          ? {
              framework: "vitest",
              total: 43,
              passed: isError ? 42 : 43,
              failed: isError ? 1 : 0,
              skipped: 0,
              suites_total: 5,
              suites_passed: isError ? 4 : 5,
              suites_failed: isError ? 1 : 0,
              duration_ms: 1_240,
            }
          : null,
    },
    created_at: at(Number(id.replace(/\D/g, "")) || 2),
    completed_at: active ? null : at((Number(id.replace(/\D/g, "")) || 2) + 1),
  };
}

function structuredCommand(id: string): ConversationItem {
  const item = tool(
    id,
    'rg "outputDelta" crates/falcondeck-daemon',
    "command",
    "completed",
    "crates/falcondeck-daemon/src/app/notifications.rs:298",
  );
  if (item.kind !== "tool_call") return item;
  return {
    ...item,
    tool_kind: "commandExecution",
    detail: {
      kind: "command_execution",
      command: 'rg "outputDelta" crates/falcondeck-daemon',
      cwd: "/Users/james/falcondeck",
      actions: [
        {
          action_kind: "search",
          command: 'rg "outputDelta" crates/falcondeck-daemon',
          name: null,
          path: "crates/falcondeck-daemon",
          query: "outputDelta",
        },
      ],
      process_id: "4242",
      duration_ms: 37,
      source: "agent",
    },
  };
}

const QA_MCP_TEXT_RESULT = Array.from(
  { length: 18 },
  (_, index) =>
    `Result ${index + 1}: streaming guidance retained by the provider.`,
).join("\n");

const QA_DYNAMIC_TEXT_RESULT = Array.from(
  { length: 16 },
  (_, index) => `Layer ${index + 1}: visual evidence retained by the provider.`,
).join("\n");

function providerTool(
  id: string,
  provider: "mcp" | "dynamic",
): ConversationItem {
  const base = tool(
    id,
    provider === "mcp" ? "Notion · Search" : "visualize · render",
    "other",
    "completed",
    provider === "mcp" ? "Found the streaming specification." : null,
  );
  if (base.kind !== "tool_call") return base;
  return provider === "mcp"
    ? {
        ...base,
        tool_kind: "mcpToolCall",
        detail: {
          kind: "mcp",
          server: "notion",
          tool: "search",
          arguments: {
            query: "message streaming",
            scope: "workspace",
            limit: 20,
            include_archived: false,
            sort: "relevance",
            language: "en",
            result_format: "structured",
            include_metadata: true,
            include_resources: true,
            provider: "notion",
            mode: "research",
          },
          result: {
            content: [
              { type: "text", text: QA_MCP_TEXT_RESULT },
              { type: "audio", url: QA_AUDIO_WAV, mimeType: "audio/wav" },
              {
                type: "resource_link",
                uri: "https://modelcontextprotocol.io",
                name: "MCP specification",
                description: "Protocol reference returned by the provider.",
              },
              {
                type: "resource",
                resource: {
                  uri: "file:///tmp/streaming-report.pdf",
                  mimeType: "application/pdf",
                  blob: "aGVsbG8=",
                  _meta: { version: 2 },
                },
              },
              {
                type: "resource",
                resource: {
                  uri: "file:///tmp/implementation-notes.md",
                  mimeType: "text/markdown",
                  text: "### Implementation notes\n\n- Preserve provider ordering\n- Keep export explicit and user initiated",
                },
              },
            ],
            structuredContent: { matches: 3, cursor: null },
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
        },
      }
    : {
        ...base,
        tool_kind: "dynamicToolCall",
        detail: {
          kind: "dynamic",
          tool: "render",
          namespace: "visualize",
          arguments: { prompt: "Falcon radar" },
          content_items: [
            { kind: "text", text: QA_DYNAMIC_TEXT_RESULT },
            {
              kind: "image",
              url: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMjAiIGhlaWdodD0iMTgwIiB2aWV3Qm94PSIwIDAgMzIwIDE4MCI+PHJlY3Qgd2lkdGg9IjMyMCIgaGVpZ2h0PSIxODAiIHJ4PSIyNCIgZmlsbD0iIzEyMTgyMSIvPjxjaXJjbGUgY3g9IjE2MCIgY3k9IjkwIiByPSI1NCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMTBiOTgxIiBzdHJva2Utd2lkdGg9IjgiLz48cGF0aCBkPSJNMTYwIDkwTDIzOCA0OCIgc3Ryb2tlPSIjN2RkM2ZjIiBzdHJva2Utd2lkdGg9IjYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjxjaXJjbGUgY3g9IjE2MCIgY3k9IjkwIiByPSI4IiBmaWxsPSIjN2RkM2ZjIi8+PC9zdmc+",
            },
          ],
          success: true,
          duration_ms: 84,
        },
      };
}

function collaborationTool(
  id: string,
  operation: "spawn" | "wait",
): ConversationItem {
  const base = tool(
    id,
    operation === "spawn" ? "Spawn sub-agent" : "Wait for sub-agents",
    "other",
    operation === "spawn" ? "completed" : "running",
    null,
  );
  if (base.kind !== "tool_call") return base;
  return {
    ...base,
    tool_kind: "collabAgentToolCall",
    detail: {
      kind: "collab_agent",
      tool: operation === "spawn" ? "spawnAgent" : "wait",
      sender_thread_id: "thread-parent",
      receiver_thread_ids:
        operation === "spawn"
          ? ["thread-ios-8f30"]
          : ["thread-ios-8f30", "thread-web-b291"],
      prompt:
        operation === "spawn"
          ? "Audit VoiceOver, stream updates, and long-thread scrolling."
          : null,
      model: operation === "spawn" ? "gpt-5.6-terra" : null,
      reasoning_effort: operation === "spawn" ? "high" : null,
      agent_states:
        operation === "spawn"
          ? {
              "thread-ios-8f30": {
                status: "completed",
                message: "iOS accessibility audit complete",
              },
            }
          : {
              "thread-ios-8f30": {
                status: "completed",
                message: "iOS audit complete",
              },
              "thread-web-b291": {
                status: "running",
                message: "Checking reconnect behavior",
              },
            },
    },
  };
}

function subagentActivity(id: string): ConversationItem {
  const base = tool(id, "Sub-agent interrupted", "other", "interrupted", null);
  if (base.kind !== "tool_call") return base;
  return {
    ...base,
    tool_kind: "subAgentActivity",
    detail: {
      kind: "subagent_activity",
      activity: "interrupted",
      agent_thread_id: "thread-web-b291",
      agent_path: "qa/reconnect",
    },
  };
}

function hookTool(id: string): ConversationItem {
  const base = tool(id, "Hook · pre tool use", "other", "completed", null);
  if (base.kind !== "tool_call") return base;
  return {
    ...base,
    tool_kind: "hookRun",
    detail: {
      kind: "hook",
      event_name: "preToolUse",
      handler_type: "command",
      execution_mode: "sync",
      scope: "turn",
      source_path: "/workspace/.codex/hooks/check.sh",
      duration_ms: 18,
      status_message: "Completed with a warning",
      entries: [
        {
          entry_kind: "warning",
          text: "Review generated migrations before applying.",
        },
      ],
    },
  };
}

type GuardianReviewStatus =
  "inProgress" | "approved" | "denied" | "timedOut" | "aborted";

function guardianReview(
  id: string,
  reviewStatus: GuardianReviewStatus,
): ConversationItem {
  const toolStatus =
    reviewStatus === "inProgress"
      ? "running"
      : reviewStatus === "approved"
        ? "completed"
        : reviewStatus === "denied"
          ? "denied"
          : "interrupted";
  const base = tool(
    id,
    "Safety review · command",
    "approval",
    toolStatus,
    null,
  );
  if (base.kind !== "tool_call") return base;
  return {
    ...base,
    tool_kind: "guardianReview",
    detail: {
      kind: "guardian_review",
      review_id: id,
      action_kind: "command",
      action: "deploy --force",
      cwd: "/workspace",
      target_item_id: "deploy-command",
      status: reviewStatus,
      risk_level: reviewStatus === "denied" ? "high" : "medium",
      user_authorization: "low",
      rationale:
        reviewStatus === "inProgress"
          ? "Checking the command against the production safety policy."
          : `The provider ${reviewStatus === "timedOut" ? "timed out reviewing" : reviewStatus} the production action.`,
      decision_source: reviewStatus === "inProgress" ? null : "agent",
      duration_ms: reviewStatus === "inProgress" ? null : 125,
    },
  };
}

type ApprovalReceiptOutcome =
  "allowed" | "always_allowed" | "denied" | "expired" | "cancelled";

function approvalReceipt(
  id: string,
  outcome: ApprovalReceiptOutcome,
  offset: number,
): ConversationItem {
  return {
    kind: "interactive_request",
    id,
    request: {
      request_id: id,
      workspace_id: "qa-workspace",
      thread_id: "qa-thread",
      method: "approval/request",
      kind: "approval",
      approval_decisions: ["allow", "deny", "always_allow"],
      title: `Allow ${id.replaceAll("-", " ")}?`,
      detail: "Retained provider context for reconnect and audit.",
      command: `npm run ${id}`,
      path: "/workspace/falcondeck",
      turn_id: "qa-turn",
      item_id: `tool-${id}`,
      questions: [],
      created_at: at(offset),
    },
    created_at: at(offset),
    resolved: true,
    resolution: { outcome, resolved_at: at(offset + 0.05) },
  };
}

const mixedItems: ConversationItem[] = [
  {
    kind: "user_message",
    id: "user-1",
    text: "Audit **every message type** on iOS.",
    attachments: [
      {
        type: "image",
        id: "attachment-ready",
        name: "reference.svg",
        mime_type: "image/svg+xml",
        url: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMjAiIGhlaWdodD0iMTgwIiB2aWV3Qm94PSIwIDAgMzIwIDE4MCI+PHJlY3Qgd2lkdGg9IjMyMCIgaGVpZ2h0PSIxODAiIHJ4PSIyNCIgZmlsbD0iIzEyMTgyMSIvPjxjaXJjbGUgY3g9IjE2MCIgY3k9IjkwIiByPSI1NCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMTBiOTgxIiBzdHJva2Utd2lkdGg9IjgiLz48cGF0aCBkPSJNMTYwIDkwTDIzOCA0OCIgc3Ryb2tlPSIjN2RkM2ZjIiBzdHJva2Utd2lkdGg9IjYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjxjaXJjbGUgY3g9IjE2MCIgY3k9IjkwIiByPSI4IiBmaWxsPSIjN2RkM2ZjIi8+PC9zdmc+",
      },
      {
        type: "image",
        id: "attachment-unavailable",
        name: "expired-reference.png",
        mime_type: "image/png",
        url: "javascript:expired-attachment",
      },
    ],
    turn_id: "turn-qa-1",
    previous_turn_id: null,
    created_at: at(0),
  },
  {
    kind: "reasoning",
    id: "reasoning-1",
    summary: "Checking native rendering",
    content:
      "Inspect Markdown, tools, plans, diffs, services, actions and accessibility.",
    duration_ms: 1840,
    created_at: at(1),
  },
  tool(
    "tool-2",
    "Read MessageRouter.tsx",
    "read",
    "completed",
    "94 lines read",
  ),
  tool(
    "tool-3",
    "npm test --workspace @falcondeck/mobile",
    "test",
    "completed",
    "All tests passed",
  ),
  {
    kind: "plan",
    id: "plan-4",
    plan: {
      explanation:
        "Validate semantics, interactions, and long-thread behavior.",
      steps: [
        { step: "Inspect mixed output", status: "completed" },
        { step: "Exercise streaming", status: "in_progress" },
        { step: "Load 1,000 blocks", status: "pending" },
      ],
    },
    created_at: at(4),
  },
  {
    kind: "diff",
    id: "diff-5",
    diff: "diff --git a/mobile.tsx b/mobile.tsx\n--- a/mobile.tsx\n+++ b/mobile.tsx\n@@ -1 +1 @@\n-old\n+world class",
    created_at: at(5),
  },
  tool(
    "tool-6",
    "npm run typecheck",
    "command",
    "failed",
    "Expected string, received null",
  ),
  {
    kind: "service",
    id: "service-7",
    level: "warning",
    message: "Recovered after reconnect.",
    created_at: at(7),
  },
  {
    kind: "service",
    id: "service-7-diagnostic",
    level: "error",
    message: JSON.stringify({
      level: "ERROR",
      fields: {
        message: "MCP server could not start. Check its configuration.",
      },
      target: "codex_core::mcp",
    }),
    created_at: at(7.05),
  },
  {
    kind: "context_compaction",
    id: "compact-7a",
    lifecycle: "succeeded",
    created_at: at(7.1),
    completed_at: at(7.2),
  },
  {
    kind: "realtime",
    id: "handoff-8",
    item_type: "handoff_request",
    title: "Voice handoff requested",
    summary: "Continue the live task in Codex with the current context.",
    payload: {
      type: "handoff_request",
      destination: "codex",
      session: "voice-qa",
      source: "realtime",
      mode: "continue",
      preserve_context: true,
      transcript_state: "final",
      audio_state: "stopped",
      reason: "provider_handoff",
    },
    created_at: at(8),
  },
];

const answer = `## Native result\n\nStreaming remains responsive with **GFM** and code:\n\n| Check | State |\n| --- | --- |\n| VoiceOver | Ready |\n| Copy | Ready |\n\nFor active development, use:\n\n\`\`\`tsx\n<FlashList data={blocks} />\n\`\`\`\n\n\`\`\`bash\nnpm test\n\`\`\`\n\nThat keeps streamed Markdown readable while the response grows.\n\n::git-commit{cwd="/Users/qa/falcondeck" commit="abc123"}\n::future-action{state=ready provider-fragment}`;

const markdownAdversarialItems: ConversationItem[] = [
  {
    kind: "user_message",
    id: "markdown-user",
    text: "Inspect the complete Markdown rhythm, safety, selection, and overflow matrix.",
    attachments: [],
    turn_id: "turn-markdown-qa",
    previous_turn_id: null,
    created_at: at(0),
  },
  {
    kind: "assistant_message",
    id: "markdown-prose-code",
    text: [
      "Prose immediately before a fence should have a clear transition.",
      "",
      "```bash",
      "make mobile-dev",
      "open -a FalconDeck",
      "```",
      "",
      "Prose immediately after the fence should have the same breathing room.",
    ].join("\n"),
    lifecycle: "complete",
    created_at: at(1),
  },
  {
    kind: "assistant_message",
    id: "markdown-consecutive-code",
    text: [
      "```tsx",
      "const first = <FlashList data={blocks} />",
      "```",
      "",
      "```json",
      '{ "state": "complete", "ordered": true }',
      "```",
    ].join("\n"),
    lifecycle: "complete",
    created_at: at(2),
  },
  {
    kind: "assistant_message",
    id: "markdown-rich-content",
    text: [
      "## Adversarial Markdown",
      "#### Deep structure",
      "##### Supporting detail",
      "###### Fine print remains legible",
      "",
      "- Nested list",
      "  1. Unicode: café · 東京 · 🚀",
      "  2. RTL: مرحباً بالعالم",
      "  3. A very long token must wrap instead of widening the transcript: `FalconDeckConversationStreamingBoundaryWithoutAnyNaturalBreakOpportunity0123456789`",
      "",
      "| Surface | State |",
      "| --- | --- |",
      "| iOS | **Ready** |",
      "| Link | [Safe link](https://falcondeck.com) |",
      "| Unsafe | [Must not execute](javascript:alert(1)) |",
      "",
      "> Blockquotes, **emphasis**, ~~deletion~~, `inline code`, and selection remain readable.",
      "",
      "```text",
      ...Array.from(
        { length: 18 },
        (_, index) => `bounded output line ${index + 1}`,
      ),
      "```",
      "",
      "```mermaid",
      "flowchart TD",
      "  home[Homepage] --> studio[Studio]",
      "```",
    ].join("\n"),
    lifecycle: "complete",
    created_at: at(3),
  },
];

type QaScenario =
  | "mixed"
  | "markdown"
  | "interrupt"
  | "history"
  | "media"
  | "tools"
  | "content"
  | "external"
  | "requests"
  | "accessibility"
  | "long";

type InterruptionPhase =
  "before_output" | "reasoning" | "text" | "tool" | "reconnect";
type HistoryRecoveryPhase = "cached" | "recovering" | "recovered" | "replayed";

const interruptionPhases: InterruptionPhase[] = [
  "before_output",
  "reasoning",
  "text",
  "tool",
  "reconnect",
];

function interruptionItems(
  phase: InterruptionPhase,
  reconnected: boolean,
): ConversationItem[] {
  const user: ConversationItem = {
    kind: "user_message",
    id: "interrupt-user",
    text: "Audit interruption and reconnect behavior without losing partial evidence.",
    attachments: [],
    turn_id: "turn-interrupt-qa",
    previous_turn_id: null,
    created_at: at(0),
  };
  const emptyReceipt: ConversationItem = {
    kind: "assistant_message",
    id: "falcondeck-turn-receipt-turn-interrupt-qa",
    text: "",
    phase: "final_answer",
    lifecycle: "interrupted",
    created_at: at(4),
  };

  if (phase === "before_output") return [user, emptyReceipt];
  if (phase === "reasoning") {
    return [
      user,
      {
        kind: "reasoning",
        id: "interrupt-reasoning",
        summary: "Checking reconnect invariants",
        content: "Partial analysis remains available after the turn stops.",
        lifecycle: "interrupted",
        duration_ms: 1_840,
        created_at: at(1),
      },
      emptyReceipt,
    ];
  }
  if (phase === "text") {
    return [
      user,
      {
        kind: "assistant_message",
        id: "interrupt-assistant",
        text: "The authoritative snapshot is replay-safe, but the final verification was",
        phase: "final_answer",
        lifecycle: "interrupted",
        created_at: at(2),
      },
    ];
  }
  if (phase === "tool") {
    return [
      user,
      tool(
        "interrupt-tool-3",
        "npm test --workspace @falcondeck/client-core",
        "test",
        "interrupted",
        "PASS replay ordering\nRUN reconnect recovery…",
      ),
      emptyReceipt,
    ];
  }

  const lifecycle = reconnected ? "interrupted" : "streaming";
  return [
    user,
    {
      kind: "reasoning",
      id: "interrupt-reasoning",
      summary: "Recovering authoritative state",
      content:
        "The same stable reasoning item keeps its partial provider evidence.",
      lifecycle,
      duration_ms: reconnected ? 2_240 : null,
      created_at: at(1),
    },
    {
      kind: "assistant_message",
      id: "interrupt-assistant",
      text: "Reconnect preserved this exact partial answer without duplication.",
      phase: "final_answer",
      lifecycle,
      created_at: at(2),
    },
    tool(
      "interrupt-tool-3",
      "npm test --workspace @falcondeck/client-core",
      "test",
      reconnected ? "interrupted" : "running",
      "PASS offset replay\nRUN authoritative refresh…",
    ),
  ];
}

const historyCachedItems: ConversationItem[] = [
  {
    kind: "user_message",
    id: "history-user-1",
    text: "Recover this thread after the relay replay window is pruned.",
    attachments: [],
    created_at: at(0),
  },
  {
    kind: "assistant_message",
    id: "history-answer-1",
    text: "Cached tail awaiting authoritative recovery…",
    phase: "final_answer",
    lifecycle: "streaming",
    created_at: at(1),
  },
];

const historyRecoveredItems: ConversationItem[] = [
  historyCachedItems[0]!,
  {
    kind: "assistant_message",
    id: "history-answer-1",
    text: "Authoritative snapshot retained the interrupted",
    phase: "final_answer",
    lifecycle: "interrupted",
    created_at: at(1),
  },
  {
    kind: "user_message",
    id: "history-user-2",
    text: "Confirm retained updates were replayed once.",
    attachments: [],
    created_at: at(2),
  },
  tool(
    "history-tool-2",
    "Verify retained replay window",
    "test",
    "completed",
    "PASS authoritative snapshot\nPASS thread detail\nPASS duplicate replay",
  ),
  {
    kind: "assistant_message",
    id: "history-answer-2",
    text: "Recovery is complete. Stable IDs were retained and duplicate events were ignored.",
    phase: "final_answer",
    lifecycle: "complete",
    created_at: at(2),
  },
];

const replaySuffix = " response.";
const recoveredText = (
  historyRecoveredItems[1] as Extract<
    ConversationItem,
    { kind: "assistant_message" }
  >
).text;
const historyReplayEvent: EventEnvelope = {
  seq: 42,
  emitted_at: at(3),
  workspace_id: "qa-workspace",
  thread_id: "qa-history-thread",
  event: {
    type: "text",
    item_id: "history-answer-1",
    delta: replaySuffix,
    start_offset: recoveredText.length,
    end_offset: recoveredText.length + replaySuffix.length,
  },
};

function historyRecoveryItems(phase: HistoryRecoveryPhase): ConversationItem[] {
  if (phase === "cached") return historyCachedItems;
  if (phase === "recovering") return [];
  if (phase === "replayed") {
    return applyConversationEventsToItems(historyRecoveredItems, [
      historyReplayEvent,
      historyReplayEvent,
    ]);
  }
  return historyRecoveredItems;
}

const QA_MEDIA_DATA_URL =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIzMjAiIGhlaWdodD0iMTgwIiB2aWV3Qm94PSIwIDAgMzIwIDE4MCI+PHJlY3Qgd2lkdGg9IjMyMCIgaGVpZ2h0PSIxODAiIHJ4PSIyNCIgZmlsbD0iIzEyMTgyMSIvPjxjaXJjbGUgY3g9IjE2MCIgY3k9IjkwIiByPSI1NCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMTBiOTgxIiBzdHJva2Utd2lkdGg9IjgiLz48cGF0aCBkPSJNMTYwIDkwTDIzOCA0OCIgc3Ryb2tlPSIjN2RkM2ZjIiBzdHJva2Utd2lkdGg9IjYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIvPjxjaXJjbGUgY3g9IjE2MCIgY3k9IjkwIiByPSI4IiBmaWxsPSIjN2RkM2ZjIi8+PC9zdmc+";

const mediaMatrixItems: ConversationItem[] = [
  {
    kind: "user_message",
    id: "media-user-1",
    text: "Compare the inline, expired remote, local-only, and unsafe references.",
    attachments: [
      {
        type: "image",
        id: "media-inline",
        name: "inline-radar.svg",
        mime_type: "image/svg+xml",
        url: QA_MEDIA_DATA_URL,
        local_path: null,
      },
      {
        type: "image",
        id: "media-remote-expired",
        name: null,
        mime_type: "image/png",
        url: "https://example.invalid/expired-reference.png?token=must-not-display",
        local_path: null,
      },
      {
        type: "image",
        id: "media-local-only",
        name: "local-reference.png",
        mime_type: "image/png",
        url: "file:///private/tmp/falcondeck-local-reference.png",
        local_path: "/private/tmp/falcondeck-local-reference.png",
      },
      {
        type: "image",
        id: "media-unsafe",
        name: "unsafe-reference.png",
        mime_type: "image/png",
        url: "javascript:alert(1)",
        local_path: null,
      },
    ],
    turn_id: "turn-media-1",
    previous_turn_id: null,
    created_at: at(0),
  },
  {
    kind: "image",
    id: "media-output-complete",
    title: "Inline generated image",
    image: {
      id: "media-output-complete-asset",
      name: "generated-radar.svg",
      mime_type: "image/svg+xml",
      url: QA_MEDIA_DATA_URL,
      local_path: null,
      alt_text: "A radar-style FalconDeck QA illustration",
    },
    lifecycle: "complete",
    created_at: at(1),
  },
  {
    kind: "image",
    id: "media-output-generating",
    title: "Generating provider image",
    image: {
      id: "media-output-generating-asset",
      name: null,
      mime_type: null,
      url: "",
      local_path: null,
      alt_text: "Provider image being generated",
    },
    lifecycle: "streaming",
    created_at: at(2),
  },
  {
    kind: "image",
    id: "media-output-interrupted",
    title: "Interrupted image with retained preview",
    image: {
      id: "media-output-interrupted-asset",
      name: "partial-radar.svg",
      mime_type: "image/svg+xml",
      url: QA_MEDIA_DATA_URL,
      local_path: null,
      alt_text: "A retained image preview from an interrupted generation",
    },
    lifecycle: "interrupted",
    created_at: at(3),
  },
  {
    kind: "image",
    id: "media-output-unavailable",
    title: "Unavailable provider image",
    image: {
      id: "media-output-unavailable-asset",
      name: "missing-image.png",
      mime_type: "image/png",
      url: "",
      local_path: null,
      alt_text: "Provider image that failed before an asset arrived",
    },
    lifecycle: "error",
    created_at: at(4),
  },
  providerTool("media-tool-5", "mcp"),
];

function normalizeQaScenario(value: string | undefined): QaScenario {
  return value === "markdown" ||
    value === "interrupt" ||
    value === "history-truncated" ||
    value === "media-matrix" ||
    value === "tools" ||
    value === "content" ||
    value === "external" ||
    value === "requests" ||
    value === "accessibility" ||
    value === "long"
    ? value === "history-truncated"
      ? "history"
      : value === "media-matrix"
        ? "media"
        : value
    : "mixed";
}

function itemBlock(item: ConversationItem): ConversationRenderBlock {
  return {
    kind: "item",
    id: `${item.kind}:${item.id}`,
    item,
    default_open: item.kind === "diff" || item.kind === "file_change",
    suppress_read_only_detail: false,
  };
}

const toolStateBlocks = [
  structuredCommand("tool-state-10"),
  providerTool("tool-state-19", "mcp"),
  providerTool("tool-state-20", "dynamic"),
  collaborationTool("tool-state-21", "spawn"),
  collaborationTool("tool-state-22", "wait"),
  subagentActivity("tool-state-23"),
  hookTool("tool-state-24"),
  guardianReview("tool-state-25-running", "inProgress"),
  guardianReview("tool-state-25-approved", "approved"),
  guardianReview("tool-state-25-denied", "denied"),
  guardianReview("tool-state-25-timed-out", "timedOut"),
  guardianReview("tool-state-25-aborted", "aborted"),
  tool("tool-state-11", "Queued command", "command", "pending", null),
  tool(
    "tool-state-12",
    "Approval-gated command",
    "approval",
    "awaiting_approval",
    "Review the requested command before continuing.",
  ),
  tool(
    "tool-state-13",
    "Streaming test output",
    "test",
    "running",
    "2 of 8 suites complete",
  ),
  tool(
    "tool-state-13b",
    "npm test --workspace @falcondeck/mobile",
    "test",
    "failed",
    "Test Files  1 failed | 4 passed (5)\nTests  1 failed | 42 passed (43)",
  ),
  tool(
    "tool-state-14",
    "Successful edit",
    "edit",
    "completed",
    "Updated 3 files",
  ),
  tool(
    "tool-state-15",
    "Failed command",
    "command",
    "failed",
    "Process exited with code 1",
  ),
  tool(
    "tool-state-16",
    "Denied install",
    "approval",
    "denied",
    "Denied by the user",
  ),
  tool(
    "tool-state-17",
    "Interrupted search",
    "search",
    "interrupted",
    "Stopped after 42 results",
  ),
  tool(
    "tool-state-18",
    "Provider-specific state",
    "other",
    "provider_magic",
    "Raw status remains inspectable",
  ),
].map(itemBlock);

const contentStateBlocks = (
  [
    {
      kind: "assistant_message",
      id: "assistant-pending",
      text: "",
      lifecycle: "pending",
      created_at: at(21),
    },
    {
      kind: "assistant_message",
      id: "assistant-streaming",
      text: "The response is arriving and remains readable while it streams.",
      phase: "commentary",
      lifecycle: "streaming",
      created_at: at(22),
    },
    {
      kind: "reasoning",
      id: "reasoning-streaming",
      summary: "Inspecting each content state",
      content:
        "Streaming reasoning opens automatically so progress is visible.",
      lifecycle: "streaming",
      created_at: at(23),
    },
    {
      kind: "image",
      id: "image-streaming",
      title: "Generating reference image",
      image: {
        id: "image-streaming-asset",
        url: "",
        alt_text: "A generated FalconDeck reference image",
      },
      lifecycle: "streaming",
      created_at: at(23.5),
    },
    {
      kind: "image",
      id: "image-complete",
      title: "Generated control deck",
      image: {
        id: "image-complete-asset",
        name: "control-deck.png",
        mime_type: "image/png",
        url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAABICAMAAAAJWw0gAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAABCUExURRIWHxMXIClKRUWJc27ntyI7Ok2cgF3AmhkmKzpxYWDGn0SHcjRjVyxQSU+hhCdFQRooLB8yNEB/bBMYIUCAbJSjuA2vBjoAAAAHdElNRQfqCAgXAjMaQEcLAAABbUlEQVRo3u1Za4+EIAxUQHARHxx7//+vXu5wV2N8dDc7NLl0PuqEjrSUtlaVQCAQvIlaabNAq8LmG2u2sE1B887swRWS0FpzBNsWsK/MGfCxcFtZ813oVR/02iM3sP0l9IdxeVqPw3IgytjXW29PXQkFj/33cedldHAvPOLvq959ne7gSGzn9cMhI8wM0Gm0V/afCizEfpMXv5+SZi9AcmKOMZ9OScnnrIzbgHhBi7AtsMRD3oGiIOUvmy6JUyam6yVfQ84BA4E5YHJBTsIjgTliEjJ9Y2dnQQR4EtXjBHQkqsYJCCRqwAnoSdQeJ4B2ttQ/3gH2GGA/BbRb1uEEcGZC9ruA/TZM1HoXVQ+QKyKNqovZa0JiVexgVTF/X8DeGfH3hs/u+MAL8O6Yfz7APyE5mhFVxWZEmymZzlMyv3qGnpLxzwn5J6UV+6z4TwLvtPwXafO/4PP3Pw1R4T78+5MQASLg/VAUCAQCNH4Aun4yBRR6+iYAAAAldEVYdGRhdGU6Y3JlYXRlADIwMjYtMDgtMDhUMjM6MDI6NTErMDA6MDCyGcM2AAAAJXRFWHRkYXRlOm1vZGlmeQAyMDI2LTA4LTA4VDIzOjAyOjUxKzAwOjAww0R7igAAACh0RVh0ZGF0ZTp0aW1lc3RhbXAAMjAyNi0wOC0wOFQyMzowMjo1MSswMDowMJRRWlUAAAAASUVORK5CYII=",
        alt_text: "A green FalconDeck radar ring over a dark control deck",
      },
      lifecycle: "complete",
      created_at: at(23.6),
    },
    {
      kind: "web_search",
      id: "search-streaming",
      search: {
        id: "search-streaming-action",
        query: "World-class streaming AI chat interfaces",
        action_kind: "search",
        queries: ["React AI chat streaming", "React Native agent chat UX"],
        url: null,
        pattern: null,
      },
      lifecycle: "streaming",
      created_at: at(23.7),
    },
    {
      kind: "web_search",
      id: "search-page",
      search: {
        id: "search-page-action",
        query: "AI Elements conversation primitives",
        action_kind: "open_page",
        queries: [],
        url: "https://elements.ai-sdk.dev/components/conversation",
        pattern: null,
      },
      lifecycle: "complete",
      created_at: at(23.8),
    },
    {
      kind: "web_search",
      id: "search-error",
      search: {
        id: "search-error-action",
        query: "Source attribution behavior",
        action_kind: "find_in_page",
        queries: [],
        url: "https://example.com/research",
        pattern: "citations",
      },
      lifecycle: "error",
      created_at: at(23.9),
    },
    {
      kind: "web_search",
      id: "search-interrupted",
      search: {
        id: "search-interrupted-action",
        query: "Preserved partial research context",
        action_kind: "open_page",
        queries: [],
        url: "https://reactnative.dev/docs/accessibility",
        pattern: null,
      },
      lifecycle: "interrupted",
      created_at: at(23.91),
    },
    {
      kind: "file_change",
      id: "file-change-complete",
      status: "completed",
      lifecycle: "succeeded",
      changes: [
        {
          path: "packages/client-core/src/types.ts",
          change_kind: "update",
          diff: "diff --git a/packages/client-core/src/types.ts b/packages/client-core/src/types.ts\n--- a/packages/client-core/src/types.ts\n+++ b/packages/client-core/src/types.ts\n@@ -1 +1 @@\n-export type State = string\n+export type State = StructuredState",
          move_path: null,
        },
        {
          path: "apps/mobile/src/components/chat/LegacyCard.tsx",
          change_kind: "update",
          diff: "",
          move_path: "apps/mobile/src/components/chat/StructuredCard.tsx",
        },
      ],
      created_at: at(23.92),
      completed_at: at(23.93),
    },
    {
      kind: "assistant_message",
      id: "assistant-cited-final",
      text: "The reconnect invariant is backed by durable protocol evidence.",
      phase: "final_answer",
      memory_citation: {
        entries: [
          {
            path: "docs/PLATFORM.md",
            line_start: 170,
            line_end: 178,
            note: "Defines stable item identity and authoritative replay ordering.",
          },
        ],
        thread_ids: ["thread-earlier"],
      },
      citations: [
        {
          id: "assistant-cited-final:citation:0",
          kind: "web_search_result_location",
          url: "https://react.dev/blog/2024/12/05/react-19",
          title: "React v19",
          cited_text: "React 19 is now stable!",
          locator: {
            kind: "search_result",
            search_result_index: 2,
            start_block_index: 4,
            end_block_index: 5,
          },
        },
        {
          id: "assistant-cited-final:citation:1",
          kind: "search_result_location",
          source: "kb://relay-invariants",
          title: "Relay invariants",
          cited_text: "Sequence numbers remain monotonic after pruning.",
        },
      ],
      lifecycle: "complete",
      created_at: at(23.95),
    },
    {
      kind: "assistant_message",
      id: "assistant-interrupted",
      text: "This partial answer is still useful and can be copied.",
      lifecycle: "interrupted",
      created_at: at(24),
    },
    {
      kind: "code_review",
      id: "review-running",
      subject: "current changes",
      content: "",
      lifecycle: "streaming",
      created_at: at(24.01),
    },
    {
      kind: "code_review",
      id: "review-complete",
      subject: "current changes",
      content:
        "## Review findings\n\n- **High:** Reconnect can replace newer streamed text.\n- **Low:** Add a regression test for replay ordering.\n\nThe remaining changes look solid.\n\n::future-review-action{state=ready provider-fragment}",
      lifecycle: "complete",
      created_at: at(24.02),
    },
    {
      kind: "code_review",
      id: "review-interrupted",
      subject: "the reconnect path",
      content:
        "## Partial finding\n\nThe snapshot merge needs a monotonic sequence guard.",
      lifecycle: "interrupted",
      created_at: at(24.03),
    },
    {
      kind: "code_review",
      id: "review-error",
      subject: "the mobile renderer",
      content: "",
      lifecycle: "error",
      created_at: at(24.04),
    },
    {
      kind: "context_compaction",
      id: "compact-running",
      lifecycle: "running",
      created_at: at(24.05),
      completed_at: null,
    },
    {
      kind: "context_compaction",
      id: "compact-complete",
      lifecycle: "succeeded",
      created_at: at(24.1),
      completed_at: at(24.15),
    },
    {
      kind: "context_compaction",
      id: "compact-failed",
      lifecycle: "failed",
      created_at: at(24.2),
      completed_at: at(24.22),
    },
    {
      kind: "assistant_message",
      id: "assistant-interrupted-empty",
      text: "",
      lifecycle: "interrupted",
      created_at: at(24.25),
    },
    {
      kind: "reasoning",
      id: "reasoning-interrupted",
      summary: "Interrupted thought",
      content: "The provider stopped before this thought completed.",
      lifecycle: "interrupted",
      duration_ms: 4300,
      created_at: at(25),
    },
    {
      kind: "assistant_message",
      id: "assistant-error",
      text: "",
      lifecycle: "error",
      created_at: at(26),
    },
    {
      kind: "reasoning",
      id: "reasoning-error",
      summary: null,
      content: "The reasoning stream ended with an error.",
      lifecycle: "error",
      duration_ms: 910,
      created_at: at(27),
    },
    {
      kind: "image",
      id: "image-error",
      title: "Failed image generation",
      image: {
        id: "image-error-asset",
        url: "",
        alt_text: "Image generation result",
      },
      lifecycle: "error",
      created_at: at(28),
    },
    {
      kind: "artifact",
      id: "artifact-streaming",
      artifact: {
        title: "Streaming prototype",
        artifact_kind: "prototype",
        url: null,
        mime_type: "text/markdown",
        version: "v3",
        content: "## Live prototype\n\nPreparing the interactive canvas…",
        payload: { title: "Streaming prototype", status: "inProgress" },
      },
      lifecycle: "streaming",
      created_at: at(28.1),
    },
    {
      kind: "artifact",
      id: "artifact-complete",
      artifact: {
        title: "release-report.json",
        artifact_kind: "report",
        url: "https://example.com/artifacts/release-report",
        mime_type: "application/json",
        version: "v4",
        content: '{"checks": 42, "status": "ready"}',
        payload: {
          title: "release-report.json",
          status: "ready",
          checks: 42,
          passed: 40,
          warned: 2,
          failed: 0,
          version: "v4",
          format: "json",
          generated_by: "provider",
          scope: "release",
          retained: true,
        },
      },
      lifecycle: "complete",
      created_at: at(28.2),
    },
    {
      kind: "artifact",
      id: "artifact-error",
      artifact: {
        title: "Failed prototype",
        artifact_kind: "prototype",
        url: "asset://failed-prototype",
        mime_type: null,
        version: null,
        content: null,
        payload: { error: "Provider stream ended unexpectedly" },
      },
      lifecycle: "error",
      created_at: at(28.3),
    },
    approvalReceipt("focused-tests", "allowed", 28.4),
    approvalReceipt("workspace-tests", "always_allowed", 28.5),
    approvalReceipt("production-deploy", "denied", 28.6),
    approvalReceipt("expired-release", "expired", 28.7),
    approvalReceipt("cancelled-migration", "cancelled", 28.8),
    {
      kind: "interactive_request",
      id: "question-answered",
      request: {
        request_id: "question-answered",
        workspace_id: "qa-workspace",
        thread_id: "qa-thread",
        method: "item/tool/requestUserInput",
        kind: "question",
        title: "Choose release settings?",
        detail: null,
        command: null,
        path: null,
        turn_id: "qa-turn",
        item_id: "qa-item",
        questions: [
          {
            id: "resolved-channel",
            header: "Channel",
            question: "Which release channel should be used?",
            is_other: false,
            is_secret: false,
            options: [
              {
                label: "Preview",
                description: "Ship to internal testers first.",
              },
            ],
          },
        ],
        created_at: at(30),
      },
      created_at: at(30),
      resolved: true,
      resolution: { outcome: "answered", resolved_at: at(30.5) },
    },
  ] satisfies ConversationItem[]
).map(itemBlock);

const externalContentBlocks = [
  "artifact-complete",
  "search-page",
  "assistant-cited-final",
].flatMap((id) => {
  const block = contentStateBlocks.find(
    (candidate) => candidate.kind === "item" && candidate.item.id === id,
  );
  return block ? [block] : [];
});

const accessibilityItemIds = new Set([
  "user-1",
  "reasoning-1",
  "tool-2",
  "plan-4",
  "diff-5",
  "tool-6",
  "service-7-diagnostic",
  "assistant-streaming",
  "image-complete",
  "search-page",
  "assistant-cited-final",
  "reasoning-interrupted",
  "artifact-complete",
  "artifact-error",
]);

const accessibilityBlocks = [
  ...mixedItems.map(itemBlock),
  ...contentStateBlocks,
].filter(
  (block) => block.kind === "item" && accessibilityItemIds.has(block.item.id),
);

const qaInteractiveRequests: InteractiveRequest[] = [
  {
    request_id: "qa-question",
    workspace_id: "qa-workspace",
    thread_id: "qa-thread",
    method: "item/tool/requestUserInput",
    kind: "question",
    title: "Choose release settings",
    detail: "Answers stay selected if submission needs to be retried.",
    command: null,
    path: null,
    turn_id: "qa-turn",
    item_id: "qa-item",
    created_at: at(31),
    questions: [
      {
        id: "channel",
        header: "Channel",
        question: "Which release channel should be used?",
        is_other: false,
        is_secret: false,
        options: [
          { label: "Preview", description: "Ship to internal testers first." },
          {
            label: "Production",
            description: "Release to every enrolled device.",
          },
        ],
      },
      {
        id: "token",
        header: "Credential",
        question: "Enter the temporary signing token.",
        is_other: true,
        is_secret: true,
        options: null,
      },
    ],
  },
  {
    request_id: "qa-approval",
    workspace_id: "qa-workspace",
    thread_id: "qa-thread",
    method: "item/commandExecution/requestApproval",
    kind: "approval",
    approval_decisions: ["allow", "deny", "always_allow"],
    title: "Allow release command?",
    detail: "The selected settings are ready to apply.",
    command: "npm run mobile-deploy",
    path: "/workspace",
    turn_id: "qa-turn",
    item_id: "qa-command",
    questions: [],
    created_at: at(32),
  },
];

const LONG_BLOCK_PREFIX: ConversationRenderBlock[] = Array.from(
  { length: 999 },
  (_, index) =>
    itemBlock(
      index % 2 === 0
        ? {
            kind: "user_message",
            id: `long-user-${index}`,
            text: `Message ${index}: preserve the visible anchor.`,
            attachments: [],
            created_at: at(index),
          }
        : {
            kind: "assistant_message",
            id: `long-assistant-${index}`,
            text: `Response ${index}: only the streaming tail should change.`,
            created_at: at(index),
          },
    ),
);

function longBlocks(tailText: string): ConversationRenderBlock[] {
  return [
    ...LONG_BLOCK_PREFIX,
    itemBlock({
      kind: "assistant_message",
      id: "long-assistant-999",
      text: tailText,
      lifecycle: tailText.length < answer.length ? "streaming" : "complete",
      created_at: at(999),
    }),
  ];
}

export default function ConversationQaScreen() {
  const { theme } = useUnistyles();
  const {
    failResponses,
    composer,
    unavailableActions,
    scenario: requestedScenario,
  } = useLocalSearchParams<{
    failResponses?: string;
    composer?: string;
    unavailableActions?: string;
    scenario?: string;
  }>();
  const shouldFailResponses = failResponses === "1";
  const showComposer = composer === "1";
  const actionsUnavailable = unavailableActions === "1";
  const [scenario, setScenario] = useState<QaScenario>(() =>
    normalizeQaScenario(requestedScenario),
  );
  const [visibleAnswer, setVisibleAnswer] = useState("");
  const [composerDraft, setComposerDraft] = useState("");
  const [composerAttachments, setComposerAttachments] = useState<ImageInput[]>(
    [],
  );
  const [composerError, setComposerError] = useState<string | null>(null);
  const [showNotice, setShowNotice] = useState(true);
  const [requestIndex, setRequestIndex] = useState(0);
  const [longStart, setLongStart] = useState(850);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [interruptionPhase, setInterruptionPhase] =
    useState<InterruptionPhase>("before_output");
  const [reconnected, setReconnected] = useState(false);
  const [historyPhase, setHistoryPhase] =
    useState<HistoryRecoveryPhase>("cached");
  const long = scenario === "long";

  useEffect(() => {
    setScenario(normalizeQaScenario(requestedScenario));
  }, [requestedScenario]);

  useEffect(() => {
    if (scenario !== "interrupt") return;
    setInterruptionPhase("before_output");
    setReconnected(false);
  }, [scenario]);

  useEffect(() => {
    if (scenario === "history") setHistoryPhase("cached");
  }, [scenario]);

  useEffect(() => {
    if (visibleAnswer.length >= answer.length) return;
    const timer = setTimeout(
      () =>
        setVisibleAnswer(
          answer.slice(0, Math.min(answer.length, visibleAnswer.length + 3)),
        ),
      35,
    );
    return () => clearTimeout(timer);
  }, [visibleAnswer]);

  useEffect(() => {
    if (long) {
      setVisibleAnswer("");
      setLongStart(850);
      setLoadingOlder(false);
    }
  }, [long]);

  const blocks = useMemo(
    () =>
      scenario === "long"
        ? longBlocks(visibleAnswer).slice(longStart)
        : scenario === "markdown"
          ? markdownAdversarialItems.map(itemBlock)
          : scenario === "interrupt"
            ? interruptionItems(interruptionPhase, reconnected).map(itemBlock)
            : scenario === "history"
              ? historyRecoveryItems(historyPhase).map(itemBlock)
              : scenario === "media"
                ? mediaMatrixItems.map(itemBlock)
                : scenario === "tools"
                  ? toolStateBlocks
                  : scenario === "external"
                    ? externalContentBlocks
                    : scenario === "content" || scenario === "requests"
                      ? contentStateBlocks
                      : scenario === "accessibility"
                        ? accessibilityBlocks
                        : [
                            ...mixedItems.map(itemBlock),
                            itemBlock({
                              kind: "assistant_message",
                              id: "assistant-8",
                              text: visibleAnswer,
                              lifecycle:
                                visibleAnswer.length < answer.length
                                  ? "streaming"
                                  : "complete",
                              created_at: at(8),
                            }),
                          ],
    [
      historyPhase,
      interruptionPhase,
      longStart,
      reconnected,
      scenario,
      visibleAnswer,
    ],
  );

  // Keep the stress harness faithful to production: a streamed tail must not
  // replace the renderItem function and invalidate otherwise stable rows.
  const lastAssistantMessageId = latestVisibleAssistantMessageId(blocks);
  const renderBlock = useCallback(
    ({ item }: { item: ConversationRenderBlock }) => (
      <MessageRouter
        item={item}
        onApprovalDecision={ignoreApprovalDecision}
        canRetryResponse={!actionsUnavailable}
        retrySource={
          scenario === "mixed" &&
          item.kind === "item" &&
          item.item.kind === "assistant_message"
            ? (mixedItems.find(
                (
                  candidate,
                ): candidate is Extract<
                  ConversationItem,
                  { kind: "user_message" }
                > =>
                  candidate.kind === "user_message" &&
                  Boolean(candidate.turn_id),
              ) ?? null)
            : null
        }
        onRetryResponse={actionsUnavailable ? undefined : simulateBranchAction}
        showReceivedAt={
          item.kind === "item" &&
          item.item.kind === "assistant_message" &&
          item.item.id === lastAssistantMessageId
        }
      />
    ),
    [actionsUnavailable, lastAssistantMessageId, scenario],
  );

  if (!__DEV__) return <Redirect href="/" />;

  return (
    <View style={styles.screen}>
      <View style={styles.header}>
        <Text
          variant="heading"
          size="sm"
          style={styles.title}
          numberOfLines={1}
          adjustsFontSizeToFit
          minimumFontScale={0.5}
        >
          Conversation QA
        </Text>
        <View style={styles.headerActions}>
          <ConversationShareButton
            items={mixedItems}
            title="Conversation QA"
            partial={scenario === "long" && longStart > 0}
          />
          <Button
            variant="secondary"
            size="sm"
            label={
              scenario === "mixed"
                ? "Markdown matrix"
                : scenario === "markdown"
                  ? "Interrupt / reconnect"
                  : scenario === "interrupt"
                    ? "History recovery"
                    : scenario === "history"
                      ? "Media matrix"
                      : scenario === "media"
                        ? "Tool states"
                        : scenario === "tools"
                          ? "Content states"
                          : scenario === "content"
                            ? "External content"
                            : scenario === "external"
                              ? "Requests"
                              : scenario === "requests"
                                ? "Accessibility"
                                : scenario === "accessibility"
                                  ? "1,000 items"
                                  : "Mixed outputs"
            }
            onPress={() =>
              setScenario((value) =>
                value === "mixed"
                  ? "markdown"
                  : value === "markdown"
                    ? "interrupt"
                    : value === "interrupt"
                      ? "history"
                      : value === "history"
                        ? "media"
                        : value === "media"
                          ? "tools"
                          : value === "tools"
                            ? "content"
                            : value === "content"
                              ? "external"
                              : value === "external"
                                ? "requests"
                                : value === "requests"
                                  ? "accessibility"
                                  : value === "accessibility"
                                    ? "long"
                                    : "mixed",
              )
            }
          />
          {scenario === "interrupt" ? (
            <Button
              variant="secondary"
              size="sm"
              label={
                interruptionPhase === "reconnect"
                  ? reconnected
                    ? "Replay live state"
                    : "Apply reconnect snapshot"
                  : "Next interruption phase"
              }
              onPress={() => {
                if (interruptionPhase === "reconnect") {
                  setReconnected((current) => !current);
                  return;
                }
                const index = interruptionPhases.indexOf(interruptionPhase);
                setInterruptionPhase(
                  interruptionPhases[index + 1] ?? "reconnect",
                );
              }}
            />
          ) : null}
          {scenario === "history" ? (
            <Button
              variant="secondary"
              size="sm"
              label={
                historyPhase === "cached"
                  ? "Simulate truncation"
                  : historyPhase === "recovering"
                    ? "Apply snapshot + detail"
                    : historyPhase === "recovered"
                      ? "Replay duplicate event"
                      : "Reset cached tail"
              }
              onPress={() =>
                setHistoryPhase((current) =>
                  current === "cached"
                    ? "recovering"
                    : current === "recovering"
                      ? "recovered"
                      : current === "recovered"
                        ? "replayed"
                        : "cached",
                )
              }
            />
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            label={scenario === "long" ? "Replay tail" : "Replay"}
            onPress={() => {
              if (scenario !== "long") setScenario("mixed");
              setVisibleAnswer("");
              setRequestIndex(0);
            }}
          />
        </View>
      </View>
      {scenario === "mixed" && showNotice ? (
        <OperationalNoticeBanner
          conditions={[
            {
              id: "qa-notice",
              key: "provider_configuration",
              workspace_id: "qa-workspace",
              level: "warning",
              message: JSON.stringify({
                level: "WARN",
                fields: {
                  message:
                    "Provider configuration changed. New turns use the updated settings.",
                  provider: "codex",
                  scope: "workspace",
                  source: "configuration",
                  model: "gpt-5",
                  approval: "on-request",
                  sandbox: "workspace-write",
                  reconnect_required: false,
                  effective: "next-turn",
                },
                target: "codex_core::config",
              }),
              source: "configWarning",
              created_at: at(0),
              updated_at: at(0),
            },
          ]}
          onDismiss={() => setShowNotice(false)}
        />
      ) : null}
      {scenario === "requests" ? (
        qaInteractiveRequests[requestIndex] ? (
          <InteractiveRequestBanner
            request={qaInteractiveRequests[requestIndex]}
            pendingCount={qaInteractiveRequests.length - requestIndex}
            onRespond={async (_response: InteractiveResponsePayload) => {
              await new Promise((resolve) => setTimeout(resolve, 250));
              if (shouldFailResponses) {
                throw new Error("QA interactive response failure");
              }
              setRequestIndex((current) => current + 1);
            }}
          />
        ) : (
          <Text variant="caption" color="success" style={styles.qaComplete}>
            All QA responses submitted
          </Text>
        )
      ) : null}
      <FlashList
        key={scenario}
        data={blocks}
        renderItem={renderBlock}
        extraData={lastAssistantMessageId}
        keyExtractor={qaBlockKey}
        getItemType={conversationRenderBlockType}
        accessibilityLabel="Conversation QA transcript"
        maintainVisibleContentPosition={{
          autoscrollToBottomThreshold: 0.2,
          startRenderingFromBottom: true,
        }}
        contentContainerStyle={styles.listContent}
        ListEmptyComponent={
          scenario === "history" && historyPhase === "recovering" ? (
            <View
              accessibilityRole="progressbar"
              accessibilityLabel="Recovering conversation history"
              style={styles.recoveryState}
            >
              <ActivityDiamond size={20} color={theme.colors.accent.default} />
              <Text variant="caption" color="muted">
                Recovering conversation history…
              </Text>
            </View>
          ) : null
        }
        ListHeaderComponent={
          scenario === "long" && longStart > 0 ? (
            <View style={styles.loadOlder}>
              <Button
                variant="ghost"
                size="sm"
                label={
                  loadingOlder
                    ? "Loading earlier messages..."
                    : "Load earlier messages"
                }
                loading={loadingOlder}
                onPress={() => {
                  if (loadingOlder) return;
                  setLoadingOlder(true);
                  setTimeout(() => {
                    setLongStart((current) => Math.max(0, current - 100));
                    setLoadingOlder(false);
                  }, 200);
                }}
              />
            </View>
          ) : null
        }
      />
      {scenario === "mixed" || scenario === "accessibility" ? (
        <UnsupportedBlock
          item={{
            kind: "unsupported",
            id: "future-1",
            output_kind: "futureCanvas",
            reason:
              "Provider output is not supported by this FalconDeck version",
            payload: {
              status: "ready",
              renderer: "futureCanvas",
              version: "vNext",
              width: 1280,
              height: 720,
              interactive: true,
              editable: false,
              source: "provider",
              transport: "app-server",
              fallback: "inspectable",
            },
            lifecycle: "complete",
            created_at: at(30),
          }}
        />
      ) : null}
      {showComposer ? (
        <View style={styles.composerQa}>
          {composerError ? (
            <Text
              variant="caption"
              color="danger"
              accessibilityLiveRegion="polite"
            >
              {composerError}
            </Text>
          ) : null}
          <ChatInput
            value={composerDraft}
            onChangeText={setComposerDraft}
            onSubmit={() => {}}
            onPickImages={() => {}}
            onPasteImage={() => {
              void pasteImageInputFromClipboard()
                .then((nextAttachments) => {
                  setComposerAttachments((current) => {
                    validateImageAttachmentBudget([
                      ...current,
                      ...nextAttachments,
                    ]);
                    return [...current, ...nextAttachments];
                  });
                  setComposerError(null);
                })
                .catch((error) => {
                  setComposerError(
                    error instanceof Error
                      ? error.message
                      : "Failed to paste clipboard image",
                  );
                });
            }}
            onTakePhoto={() => {}}
            onRemoveAttachment={(attachmentId) =>
              setComposerAttachments((current) =>
                current.filter((attachment) => attachment.id !== attachmentId),
              )
            }
            attachments={composerAttachments}
            skills={[]}
            models={QA_MODELS}
            selectedModel={null}
            selectedEffort="medium"
            effortOptions={["medium"]}
            selectedProvider="codex"
            showProviderSelector={false}
            onSelectModel={() => {}}
            onSelectEffort={() => {}}
            onSelectProvider={() => {}}
            capabilities={{
              supports_review: true,
              supports_goals: true,
              supports_images: true,
              supports_skills: true,
              supports_interrupt: true,
              supports_steering: true,
              supports_forking: true,
              sandbox_modes: [],
              permission_modes: [],
            }}
          />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  screen: {
    flex: 1,
    backgroundColor: theme.colors.surface[0],
    paddingTop: theme.spacing[12],
  },
  header: {
    minHeight: 52,
    alignItems: "stretch",
    gap: theme.spacing[2],
    borderBottomColor: theme.colors.border.subtle,
    borderBottomWidth: 1,
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[2],
  },
  title: {
    textAlign: "center",
  },
  headerActions: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: theme.spacing[2],
  },
  listContent: {
    paddingVertical: theme.spacing[4],
  },
  loadOlder: {
    alignItems: "center",
    paddingBottom: theme.spacing[3],
  },
  recoveryState: {
    minHeight: 240,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: theme.spacing[2],
  },
  qaComplete: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
  },
  composerQa: {
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
}));

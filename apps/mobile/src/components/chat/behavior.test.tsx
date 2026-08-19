import React from "react";
import * as Clipboard from "expo-clipboard";
import { AccessibilityInfo } from "react-native";
import { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const respondApprovalMock = vi.fn();

vi.mock("react-native-reanimated", () => ({
  View: "Animated.View",
  useSharedValue: (init: any) => {
    const value: { value: any; get: () => any; set: (next: any) => void } = {
      value: init,
      get: () => value.value,
      set: (next) => {
        value.value = next;
      },
    };
    return value;
  },
  useAnimatedStyle: (fn: any) => fn(),
  useDerivedValue: (fn: any) => ({ value: fn() }),
  useReducedMotion: () => false,
  withTiming: (value: any) => value,
  withRepeat: (value: any) => value,
  withSequence: (...values: any[]) => values[0],
  withDelay: (_delay: any, value: any) => value,
  cancelAnimation: () => {},
  Easing: {
    out: (fn: any) => fn,
    cubic: (t: any) => t,
    linear: (t: any) => t,
  },
  default: {
    View: "Animated.View",
    createAnimatedComponent: (component: any) => component,
  },
}));

import { cleanup, renderComponent, textOf } from "@/test/render";

import { AssistantMessageBlock } from "./AssistantMessageBlock";
import { DiffBlock } from "./DiffBlock";
import { InputToolbar } from "./InputToolbar";
import { InteractiveRequestBlock } from "./InteractiveRequestBlock";
import { JumpToBottomFab } from "./JumpToBottomFab";
import { LiveActivityLane } from "./LiveActivityLane";
import { MarkdownRenderer } from "./MarkdownRenderer";
import { MessageRouter } from "./MessageRouter";
import { MessageActions } from "./MessageActions";
import { PlanBlock } from "./PlanBlock";
import { ServiceBlock } from "./ServiceBlock";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { ToolBurstBlock } from "./ToolBurstBlock";
import { ToolCallBlock } from "./ToolCallBlock";
import { UserMessageBlock } from "./UserMessageBlock";

afterEach(() => {
  cleanup();
  respondApprovalMock.mockReset();
});

describe("chat behavior components", () => {
  beforeEach(() => {
    respondApprovalMock.mockReset();
  });

  it("renders markdown-driven message blocks", () => {
    const assistant = renderComponent(
      <AssistantMessageBlock
        item={{
          kind: "assistant_message",
          id: "a1",
          text: "Assistant text",
          created_at: "2026-03-16T10:00:00Z",
        }}
      />,
    );
    const user = renderComponent(
      <UserMessageBlock
        item={{
          kind: "user_message",
          id: "u1",
          text: "User text",
          attachments: [
            {
              type: "image",
              id: "img-1",
              name: "evidence.png",
              mime_type: "image/png",
              url: "data:image/png;base64,abc",
            },
          ],
          created_at: "2026-03-16T10:00:00Z",
        }}
      />,
    );
    const userWithoutAttachment = renderComponent(
      <UserMessageBlock
        item={{
          kind: "user_message",
          id: "u2",
          text: "Second user text",
          attachments: [],
          created_at: "2026-03-16T10:00:00Z",
        }}
      />,
    );
    const markdown = renderComponent(
      <MarkdownRenderer text="Plain markdown text" />,
    );

    expect(textOf(assistant)).toContain("Assistant text");
    expect(textOf(user)).toContain("User text");
    expect(textOf(user)).toContain("evidence.png");
    expect(
      user.root.findAllByProps({ accessibilityLabel: "Copy message" }),
    ).toHaveLength(0);
    expect(
      assistant.root.findAllByProps({ accessibilityLabel: "Copy response" }),
    ).toHaveLength(2);
    expect(
      assistant.root.findAllByProps({ accessibilityLabel: "Read aloud" }),
    ).toHaveLength(2);
    expect(textOf(userWithoutAttachment)).toContain("Second user text");
    expect(textOf(markdown)).toContain("Plain markdown text");
  });

  it("confirms a copied response and resets when streaming adds text", async () => {
    const copy = vi.spyOn(Clipboard, "setStringAsync").mockResolvedValue(true);
    const announce = vi.spyOn(AccessibilityInfo, "announceForAccessibility");
    const actions = renderComponent(
      <MessageActions text="Copy the complete response" />,
    );
    const button = actions.root.findByProps({
      accessibilityLabel: "Copy response",
    });

    await act(async () => {
      button.props.onPress({});
      await Promise.resolve();
    });

    expect(copy).toHaveBeenCalledWith("Copy the complete response");
    expect(
      actions.root.findByProps({ accessibilityLabel: "Response copied" }),
    ).toBeDefined();
    expect(announce).toHaveBeenCalledWith("Response copied");

    act(() => {
      actions.update(
        <MessageActions text="Copy the complete response with more tokens" />,
      );
    });

    expect(
      actions.root.findByProps({ accessibilityLabel: "Copy response" }),
    ).toBeDefined();
    copy.mockRestore();
    announce.mockRestore();
  });

  it("shows compact actions only for complete assistant responses", () => {
    const complete = renderComponent(
      <AssistantMessageBlock
        item={{
          kind: "assistant_message",
          id: "directive-complete",
          text: 'Release completed.\n::git-commit{cwd="/workspace/falcondeck" commit=abc123}',
          lifecycle: "complete",
          created_at: "2026-08-09T12:00:00Z",
        }}
      />,
    );

    expect(
      complete.root.findAllByProps({ accessibilityLabel: "Copy response" }),
    ).toHaveLength(2);
    expect(
      complete.root.findAllByProps({ accessibilityLabel: "Read aloud" }),
    ).toHaveLength(2);

    const streaming = renderComponent(
      <AssistantMessageBlock
        item={{
          kind: "assistant_message",
          id: "directive-streaming",
          text: 'Saved.\n::git-commit{cwd="/workspace/falcondeck"',
          lifecycle: "streaming",
          created_at: "2026-08-09T12:01:00Z",
        }}
      />,
    );
    expect(
      streaming.root.findAllByProps({ accessibilityLabel: "Copy response" }),
    ).toHaveLength(0);
    expect(
      streaming.root.findAllByProps({ accessibilityLabel: "Read aloud" }),
    ).toHaveLength(0);
  });

  it("reports a failed response copy and keeps retry available", async () => {
    const copy = vi
      .spyOn(Clipboard, "setStringAsync")
      .mockRejectedValue(new Error("denied"));
    const announce = vi.spyOn(AccessibilityInfo, "announceForAccessibility");
    const actions = renderComponent(
      <MessageActions text="Copy the complete response" />,
    );

    await act(async () => {
      actions.root
        .findByProps({ accessibilityLabel: "Copy response" })
        .props.onPress({});
      await Promise.resolve();
    });

    expect(
      actions.root.findByProps({
        accessibilityLabel: "Could not copy response. Retry",
      }),
    ).toBeDefined();
    expect(announce).toHaveBeenCalledWith("Could not copy response");
    copy.mockRestore();
    announce.mockRestore();
  });

  it("treats a native false result as a failed response copy", async () => {
    const copy = vi.spyOn(Clipboard, "setStringAsync").mockResolvedValue(false);
    const actions = renderComponent(
      <MessageActions text="Copy the complete response" />,
    );

    await act(async () => {
      actions.root
        .findByProps({ accessibilityLabel: "Copy response" })
        .props.onPress({});
      await Promise.resolve();
    });

    expect(
      actions.root.findByProps({
        accessibilityLabel: "Could not copy response. Retry",
      }),
    ).toBeDefined();
    copy.mockRestore();
  });

  it.each([
    ["pending", "", "Preparing response…", undefined, undefined],
    [
      "streaming",
      "Partial response",
      "Partial response",
      undefined,
      undefined,
    ],
    [
      "interrupted",
      "Partial response",
      "Response interrupted",
      "Response interrupted",
      "polite",
    ],
    ["error", "", "Response failed", "Response failed", "assertive"],
  ] as const)(
    "renders the %s assistant lifecycle",
    (lifecycle, message, visibleLabel, accessibilityLabel, liveRegion) => {
      const renderer = renderComponent(
        <AssistantMessageBlock
          item={{
            kind: "assistant_message",
            id: `assistant-${lifecycle}`,
            text: message,
            lifecycle,
            created_at: "2026-03-16T10:00:00Z",
          }}
        />,
      );

      expect(textOf(renderer)).toContain(visibleLabel);
      if (lifecycle === "streaming") {
        expect(textOf(renderer)).not.toContain("Streaming…");
        expect(
          renderer.root.findAllByProps({
            accessibilityLabel: "Response streaming",
          }),
        ).toHaveLength(0);
      }
      if (accessibilityLabel) {
        expect(
          renderer.root.findByProps({ accessibilityLabel }).props
            .accessibilityLiveRegion,
        ).toBe(liveRegion);
      }
    },
  );

  it("keeps an empty interrupted assistant receipt visible and non-copyable", () => {
    const renderer = renderComponent(
      <AssistantMessageBlock
        item={{
          kind: "assistant_message",
          id: "assistant-empty-interrupted",
          text: "",
          lifecycle: "interrupted",
          created_at: "2026-03-16T10:00:00Z",
        }}
      />,
    );

    expect(textOf(renderer)).toContain("Response interrupted");
    expect(
      renderer.root.findAllByProps({ accessibilityLabel: "Copy response" }),
    ).toHaveLength(0);
  });

  it("surfaces provider detail on a failed assistant receipt", () => {
    const renderer = renderComponent(
      <AssistantMessageBlock
        item={{
          kind: "assistant_message",
          id: "assistant-error-detail",
          text: "",
          lifecycle: "error",
          error: "No endpoints match your OpenRouter privacy settings",
          created_at: "2026-03-16T10:00:00Z",
        }}
      />,
    );

    expect(textOf(renderer)).toContain(
      "No endpoints match your OpenRouter privacy settings",
    );
    expect(
      renderer.root.findByProps({
        accessibilityLabel:
          "Response failed. No endpoints match your OpenRouter privacy settings",
      }).props.accessibilityLiveRegion,
    ).toBe("assertive");
  });

  it("renders service messages and thinking indicator", () => {
    const service = renderComponent(
      <ServiceBlock
        item={{
          kind: "service",
          id: "s1",
          level: "info",
          message: "Background sync",
          created_at: "2026-03-16T10:00:00Z",
        }}
      />,
    );
    const thinking = renderComponent(<ThinkingIndicator />);

    expect(textOf(service)).toContain("Background sync");
    expect(textOf(thinking)).toContain("Thinking…");
  });

  it("renders model and effort chips in the toolbar", () => {
    const renderer = renderComponent(
      <InputToolbar
        models={[
          { id: "gpt-5", label: "GPT-5", is_default: true } as any,
          { id: "gpt-5-mini", label: "GPT-5 Mini", is_default: false } as any,
        ]}
        selectedModel="gpt-5"
        selectedEffort="medium"
        effortOptions={["low", "medium", "high"]}
        selectedProvider="codex"
        showProviderSelector
        onSelectModel={vi.fn()}
        onSelectEffort={vi.fn()}
        onSelectProvider={vi.fn()}
      />,
    );

    expect(textOf(renderer)).toContain("gpt-5");
    expect(textOf(renderer)).toContain("Medium");
    expect(textOf(renderer)).toContain("Codex");
    expect(textOf(renderer)).toContain("Claude");
  });

  it("disables toolbar controls when the composer is disabled", () => {
    const renderer = renderComponent(
      <InputToolbar
        models={[{ id: "gpt-5", label: "GPT-5", is_default: true } as any]}
        selectedModel="gpt-5"
        selectedEffort="medium"
        effortOptions={["medium"]}
        selectedProvider="codex"
        showProviderSelector
        disabled
        onSelectModel={vi.fn()}
        onSelectEffort={vi.fn()}
        onSelectProvider={vi.fn()}
      />,
    );

    const buttons = renderer.root.findAllByType("Pressable" as any);
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((button) => button.props.disabled === true)).toBe(
      true,
    );
  });

  it("handles jump-to-bottom actions", () => {
    const onJump = vi.fn();
    const jump = renderComponent(<JumpToBottomFab visible onPress={onJump} />);

    act(() => {
      jump.root.findByType("Pressable" as any).props.onPress();
    });

    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it("renders tool, diff, and plan blocks", () => {
    const tool = renderComponent(
      <ToolCallBlock
        item={{
          kind: "tool_call",
          id: "tool-1",
          title: "Read file",
          tool_kind: "read",
          status: "completed",
          output: "file contents",
          exit_code: 0,
          display: {
            is_read_only: true,
            has_side_effect: false,
            is_error: false,
            artifact_kind: "none",
            activity_kind: "read",
            history_mode: "full",
            summary_hint: null,
          },
          created_at: "2026-03-16T10:00:00Z",
          completed_at: "2026-03-16T10:00:01Z",
        }}
        defaultOpen={false}
        suppressDetail={false}
      />,
    );
    const burst = renderComponent(
      <ToolBurstBlock
        items={[
          {
            kind: "tool_call",
            id: "tool-2",
            title: "Search repo",
            tool_kind: "grep",
            status: "completed",
            output: "search output",
            exit_code: 0,
            display: {
              is_read_only: true,
              has_side_effect: false,
              is_error: false,
              artifact_kind: "none",
              activity_kind: "search",
              history_mode: "summary",
              summary_hint: null,
            },
            created_at: "2026-03-16T10:00:00Z",
            completed_at: "2026-03-16T10:00:01Z",
          } as any,
        ]}
        summary={{
          family: "explore",
          count: 2,
          title: "2 read-only tools",
          subtitle: null,
          labels: ["read", "grep"],
          counts: { read: 1, search: 1 },
          started_at: "2026-03-16T10:00:00Z",
          completed_at: "2026-03-16T10:00:01Z",
          summary_hint: null,
        }}
        defaultOpen
        suppressDetail={false}
      />,
    );
    const diff = renderComponent(
      <DiffBlock
        item={
          {
            kind: "diff",
            id: "d1",
            diff: "+added\n-removed",
            created_at: "2026-03-16T10:00:00Z",
          } as any
        }
        defaultOpen
      />,
    );
    const plan = renderComponent(
      <PlanBlock
        item={
          {
            kind: "plan",
            id: "p1",
            plan: {
              explanation: "Plan explanation",
              steps: [
                { step: "Inspect state", status: "completed" },
                { step: "Refactor list", status: "in_progress" },
              ],
            },
            created_at: "2026-03-16T10:00:00Z",
          } as any
        }
      />,
    );
    const liveLane = renderComponent(
      <LiveActivityLane
        groups={[
          {
            kind: "live_activity_group",
            id: "live-1",
            items: [
              {
                kind: "tool_call",
                id: "tool-live-1",
                title: "Search repo",
                tool_kind: "grep",
                status: "running",
                output: null,
                exit_code: null,
                display: {
                  is_read_only: true,
                  has_side_effect: false,
                  is_error: false,
                  artifact_kind: "none",
                  activity_kind: "search",
                  history_mode: "summary",
                  summary_hint: "Search workspace",
                },
                created_at: "2026-03-16T10:00:00Z",
                completed_at: null,
              } as any,
            ],
            summary: {
              family: "explore",
              count: 1,
              title: "Exploring 1 search",
              subtitle: "Search workspace",
              labels: ["Search workspace"],
              counts: { search: 1 },
              started_at: "2026-03-16T10:00:00Z",
              completed_at: null,
              summary_hint: "Search workspace",
            },
          },
        ]}
      />,
    );

    expect(textOf(tool)).toContain("Read file");
    expect(textOf(burst)).toContain("2 read-only tools");
    expect(textOf(diff)).toContain("Diff");
    expect(textOf(plan)).toContain("Plan explanation");
    expect(textOf(plan)).toContain("Refactor list");
    expect(textOf(liveLane)).toContain("Exploring 1 search");
  });

  it.each([
    ["queued", "Queued"],
    ["awaiting_approval", "Awaiting approval"],
    ["running", "Running"],
    ["succeeded", "Completed"],
    ["failed", "Failed"],
    ["denied", "Denied"],
    ["interrupted", "Interrupted"],
    ["unknown", "Unknown status"],
  ] as const)("announces the %s tool lifecycle", (lifecycle, label) => {
    const renderer = renderComponent(
      <ToolCallBlock
        item={{
          kind: "tool_call",
          id: `tool-${lifecycle}`,
          title: "Run checks",
          tool_kind: "commandExecution",
          status: "provider_specific",
          output: "Details",
          exit_code: null,
          display: {
            is_read_only: false,
            has_side_effect: true,
            is_error: lifecycle === "failed" || lifecycle === "denied",
            lifecycle,
            artifact_kind: "command_output",
            activity_kind: "command",
            history_mode: "full",
            summary_hint: null,
          },
          created_at: "2026-03-16T10:00:00Z",
          completed_at: lifecycle === "running" ? null : "2026-03-16T10:00:01Z",
        }}
        defaultOpen={false}
        suppressDetail={false}
      />,
    );

    expect(
      renderer.root.findByProps({ accessibilityLabel: `Run checks, ${label}` })
        .props.accessibilityLiveRegion,
    ).toBe("polite");
  });

  it("keeps approval-waiting tool context expanded and non-collapsible", () => {
    const renderer = renderComponent(
      <ToolCallBlock
        item={{
          kind: "tool_call",
          id: "tool-approval",
          title: "Install package",
          tool_kind: "commandExecution",
          status: "awaiting_approval",
          output: "npm install package",
          exit_code: null,
          display: {
            is_read_only: false,
            has_side_effect: true,
            is_error: false,
            lifecycle: "awaiting_approval",
            artifact_kind: "approval_related",
            activity_kind: "approval",
            history_mode: "full",
            summary_hint: null,
          },
          created_at: "2026-03-16T10:00:00Z",
          completed_at: null,
        }}
        defaultOpen={false}
        suppressDetail={false}
      />,
    );

    const header = renderer.root.findByProps({
      accessibilityLabel: "Install package, Awaiting approval",
    });
    expect(header.props.disabled).toBe(true);
    expect(header.props.accessibilityState).toEqual({
      expanded: true,
      disabled: true,
    });
    expect(textOf(renderer)).toContain("npm install package");
  });

  it("hides unresolved interactive requests so only the pinned banner handles them", () => {
    // The pinned InteractiveRequestBanner owns the live flow (question forms,
    // AlwaysAllow, offered decisions); an inline Deny/Allow pair was wrong for
    // questions and ignored approval_decisions.
    const block = renderComponent(
      <InteractiveRequestBlock
        item={
          {
            kind: "interactive_request",
            id: "ir-1",
            resolved: false,
            request: {
              request_id: "req-1",
              kind: "approval",
              title: "Run command",
              detail: "Needs approval",
              command: "ls -la",
            },
            created_at: "2026-03-16T10:00:00Z",
          } as any
        }
      />,
    );
    expect(block.toJSON()).toBeNull();

    const router = renderComponent(
      <MessageRouter
        onApprovalDecision={respondApprovalMock}
        item={
          {
            id: "router-1",
            kind: "item",
            default_open: false,
            suppress_read_only_detail: false,
            item: {
              kind: "interactive_request",
              id: "ir-2",
              resolved: false,
              request: {
                request_id: "req-2",
                kind: "question",
                title: "Pick an option",
                detail: "Answer in the banner",
                command: null,
              },
              created_at: "2026-03-16T10:00:00Z",
            },
          } as any
        }
      />,
    );
    expect(router.toJSON()).toBeNull();
    expect(respondApprovalMock).not.toHaveBeenCalled();
  });

  it("keeps denied and answered receipts compact with complete expandable evidence", () => {
    const denied = renderComponent(
      <InteractiveRequestBlock
        item={
          {
            kind: "interactive_request",
            id: "denied-1",
            resolved: true,
            resolution: {
              outcome: "denied",
              resolved_at: "2026-08-09T12:01:00Z",
            },
            request: {
              request_id: "denied-1",
              kind: "approval",
              title: "Allow npm test?",
              detail: "Runs the focused test suite.",
              command: "npm test",
              path: "/workspace/falcondeck",
              questions: [],
            },
            created_at: "2026-08-09T12:00:00Z",
          } as any
        }
      />,
    );
    expect(textOf(denied)).toContain("Denied npm test");
    const deniedDisclosure = denied.root.findByProps({
      accessibilityLabel: "Denied npm test. npm test",
    });
    expect(deniedDisclosure.props.accessibilityState).toEqual({
      expanded: false,
    });
    expect(textOf(denied)).not.toContain("Runs the focused test suite.");
    act(() => deniedDisclosure.props.onPress());
    expect(deniedDisclosure.props.accessibilityState).toEqual({
      expanded: true,
    });
    expect(textOf(denied)).toContain("Runs the focused test suite.");
    expect(textOf(denied)).toContain("/workspace/falcondeck");
    const selectableDeniedEvidence = denied.root
      .findAllByType("Text" as any)
      .filter((node) => node.props.selectable === true)
      .flatMap((node) =>
        node.children.filter(
          (child): child is string => typeof child === "string",
        ),
      )
      .join("\n");
    expect(selectableDeniedEvidence).toContain("npm test");
    expect(selectableDeniedEvidence).toContain("Runs the focused test suite.");
    expect(selectableDeniedEvidence).toContain("/workspace/falcondeck");
    expect(
      denied.root.findAllByProps({ accessibilityLabel: "Deny" }),
    ).toHaveLength(0);
    expect(
      denied.root.findAllByProps({ accessibilityLabel: "Allow" }),
    ).toHaveLength(0);

    const answered = renderComponent(
      <InteractiveRequestBlock
        item={
          {
            kind: "interactive_request",
            id: "answered-1",
            resolved: true,
            resolution: {
              outcome: "answered",
              resolved_at: "2026-08-09T12:01:00Z",
            },
            request: {
              request_id: "answered-1",
              kind: "question",
              title: "Choose release settings?",
              detail: null,
              command: null,
              path: null,
              questions: [
                {
                  id: "channel",
                  header: "Channel",
                  question: "Which release channel should be used?",
                  is_other: false,
                  is_secret: false,
                  options: [
                    { label: "Preview", description: "Ship internally first." },
                  ],
                },
              ],
            },
            created_at: "2026-08-09T12:00:00Z",
          } as any
        }
      />,
    );
    expect(textOf(answered)).toContain("Answered: Choose release settings");
    expect(
      textOf(answered).split("Which release channel should be used?"),
    ).toHaveLength(2);
    const answeredDisclosure = answered.root.findByProps({
      accessibilityLabel:
        "Answered: Choose release settings. Which release channel should be used?",
    });
    act(() => answeredDisclosure.props.onPress());
    expect(
      textOf(answered).split("Which release channel should be used?"),
    ).toHaveLength(3);
    expect(textOf(answered)).toContain("Preview — Ship internally first.");
  });

  it.each([
    ["allowed", "Allowed focused tests"],
    ["always_allowed", "Always allowed focused tests"],
    ["denied", "Denied focused tests"],
    ["expired", "Expired: Allow focused tests"],
    ["cancelled", "Cancelled: Allow focused tests"],
  ] as const)(
    "renders the %s approval outcome as inert history",
    (outcome, label) => {
      const renderer = renderComponent(
        <InteractiveRequestBlock
          item={
            {
              kind: "interactive_request",
              id: `receipt-${outcome}`,
              resolved: true,
              resolution: {
                outcome,
                resolved_at: "2026-08-09T12:01:00Z",
              },
              request: {
                request_id: `receipt-${outcome}`,
                kind: "approval",
                title: "Allow focused tests?",
                detail: null,
                command: null,
                path: null,
                questions: [],
              },
              created_at: "2026-08-09T12:00:00Z",
            } as any
          }
        />,
      );

      expect(textOf(renderer)).toContain(label);
      expect(
        renderer.root.findAllByProps({ accessibilityLabel: "Allow" }),
      ).toHaveLength(0);
      expect(
        renderer.root.findAllByProps({ accessibilityLabel: "Deny" }),
      ).toHaveLength(0);
    },
  );

  it("routes common block kinds through the message router", () => {
    const renderer = renderComponent(
      <>
        <MessageRouter
          onApprovalDecision={respondApprovalMock}
          item={
            {
              id: "user-router",
              kind: "item",
              default_open: false,
              suppress_read_only_detail: false,
              item: {
                kind: "user_message",
                id: "u2",
                text: "Hello router",
                attachments: [],
                created_at: "2026-03-16T10:00:00Z",
              },
            } as any
          }
        />
        <MessageRouter
          onApprovalDecision={respondApprovalMock}
          item={
            {
              id: "service-router",
              kind: "item",
              default_open: false,
              suppress_read_only_detail: false,
              item: {
                kind: "service",
                id: "s2",
                level: "warning",
                message: "Router service",
                created_at: "2026-03-16T10:00:00Z",
              },
            } as any
          }
        />
        <MessageRouter
          onApprovalDecision={respondApprovalMock}
          item={
            {
              id: "burst-router",
              kind: "tool_summary",
              default_open: false,
              suppress_read_only_detail: false,
              items: [],
              summary: {
                family: "explore",
                count: 1,
                title: "1 read-only tool",
                subtitle: null,
                labels: ["read"],
                counts: { read: 1 },
                started_at: "2026-03-16T10:00:00Z",
                completed_at: "2026-03-16T10:00:01Z",
                summary_hint: null,
              },
            } as any
          }
        />
      </>,
    );

    expect(textOf(renderer)).toContain("Hello router");
    expect(textOf(renderer)).toContain("Router service");
    expect(textOf(renderer)).toContain("1 read-only tool");
  });
});

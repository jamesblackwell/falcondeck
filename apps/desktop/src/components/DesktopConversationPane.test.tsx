import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DesktopConversationPane } from "./DesktopConversationPane";

const noop = vi.fn();

describe("DesktopConversationPane", () => {
  it("surfaces an active harness goal above the prompt input", () => {
    render(
      <DesktopConversationPane
        selectedWorkspace={null}
        selectedThread={null}
        selectedWorkspaceId={null}
        selectedThreadId={null}
        remoteStatus={null}
        pairingLink={null}
        isStartingRemote={false}
        remoteControlsDisabled={false}
        remoteControlsUnavailableReason={null}
        conversationItems={[]}
        preferences={null}
        conversationEmptyState={null}
        isSending={false}
        isThreadDetailPending={false}
        interactiveRequests={[]}
        operationalConditions={[]}
        onDismissOperationalCondition={noop}
        onStartPairing={noop}
        onInteractiveResponse={noop}
        promptInputProps={{
          value: "",
          onValueChange: noop,
          onSubmit: noop,
          attachments: [],
          selectedProvider: "codex",
          onProviderChange: noop,
          models: [],
          selectedModelId: null,
          onModelChange: noop,
          reasoningOptions: [],
          selectedEffort: null,
          onEffortChange: noop,
          goal: {
            goal: {
              objective: "Exercise the goal loop",
              status: "active",
              token_budget: null,
              tokens_used: null,
              started_at: "2026-08-31T10:00:00Z",
              elapsed_ms: null,
              continuation_count: 0,
              last_continued_at: null,
            },
            provider: "codex",
            onClearGoal: noop,
          },
        }}
      />,
    );

    const composer = screen.getByRole("textbox", { name: "Message composer" });
    const goal = screen.getByRole("button", {
      name: /Goal: Exercise the goal loop/,
    });

    expect(goal.compareDocumentPosition(composer)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });
});

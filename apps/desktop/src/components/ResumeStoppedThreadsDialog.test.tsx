import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ThreadSummary } from "@falcondeck/client-core";

import { ResumeStoppedThreadsDialog } from "./ResumeStoppedThreadsDialog";

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: "thread-1",
    workspace_id: "workspace-1",
    title: "Pricing and unlimited",
    provider: "codex",
    native_session_id: null,
    status: "error",
    updated_at: "2026-08-14T10:00:00Z",
    last_message_preview: null,
    latest_turn_id: null,
    latest_plan: null,
    latest_diff: null,
    last_tool: null,
    last_error: "FalconDeck was closed while this turn was running",
    is_archived: false,
    is_pinned: false,
    is_pinned_in_project: false,
    goal: null,
    queued_turns: [],
    variant: null,
    agent: {
      model_id: null,
      reasoning_effort: null,
      collaboration_mode_id: null,
      approval_policy: null,
      service_tier: null,
    },
    attention: {
      level: "error",
      badge_label: null,
      unread: false,
      pending_approval_count: 0,
      pending_question_count: 0,
      last_agent_activity_seq: 0,
      last_read_seq: 0,
    },
    ...overrides,
  };
}

describe("ResumeStoppedThreadsDialog", () => {
  it("counts the stopped sessions and continues them all in one click", () => {
    const onContinueAll = vi.fn();
    const onDismiss = vi.fn();
    render(
      <ResumeStoppedThreadsDialog
        threads={[
          thread(),
          thread({ id: "thread-2", title: "Relay reconnect" }),
        ]}
        onContinueAll={onContinueAll}
        onDismiss={onDismiss}
      />,
    );

    expect(
      screen.getByText("2 sessions were stopped when FalconDeck closed"),
    ).toBeInTheDocument();
    expect(screen.getByText("Pricing and unlimited")).toBeInTheDocument();
    expect(screen.getByText("Relay reconnect")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Continue all" }));
    expect(onContinueAll).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("reads as singular for a lone stopped session", () => {
    render(
      <ResumeStoppedThreadsDialog
        threads={[thread()]}
        onContinueAll={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(
      screen.getByText("1 session was stopped when FalconDeck closed"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("summarises the tail instead of listing every thread", () => {
    render(
      <ResumeStoppedThreadsDialog
        threads={Array.from({ length: 8 }, (_, index) =>
          thread({ id: `thread-${index}`, title: `Thread ${index}` }),
        )}
        onContinueAll={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(screen.getByText("Thread 4")).toBeInTheDocument();
    expect(screen.queryByText("Thread 5")).not.toBeInTheDocument();
    expect(screen.getByText("and 3 more")).toBeInTheDocument();
  });

  it("disables repeat clicks while the continuations are starting", () => {
    const onContinueAll = vi.fn();
    render(
      <ResumeStoppedThreadsDialog
        threads={[thread()]}
        onContinueAll={onContinueAll}
        onDismiss={() => {}}
        isContinuing
      />,
    );

    expect(screen.getByRole("button", { name: "Continuing…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Not now" })).toBeDisabled();
  });

  it("keeps dismissal available while affected projects reconnect", () => {
    render(
      <ResumeStoppedThreadsDialog
        threads={[thread()]}
        onContinueAll={() => {}}
        onDismiss={() => {}}
        isPreparing
      />,
    );

    expect(screen.getByRole("button", { name: "Reconnecting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Not now" })).toBeEnabled();
  });

  it("renders nothing when no session was stopped", () => {
    const { container } = render(
      <ResumeStoppedThreadsDialog
        threads={[]}
        onContinueAll={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});

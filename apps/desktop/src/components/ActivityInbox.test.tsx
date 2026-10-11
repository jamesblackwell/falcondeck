import React from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  InteractiveRequest,
  ProjectGroup,
  ThreadSummary,
  WorkspaceSummary,
} from "@falcondeck/client-core";
import { ActivityInbox, type ActivityInboxProps } from "@falcondeck/chat-ui";

const workspace = {
  id: "workspace-1",
  path: "/projects/falcon",
  status: "ready",
  agents: [],
  default_provider: "codex",
  models: [],
  collaboration_modes: [],
  account: { status: "ready", label: "Ready" },
  current_thread_id: null,
  connected_at: "2026-08-13T09:00:00Z",
  updated_at: "2026-08-13T09:00:00Z",
  last_error: null,
} as WorkspaceSummary;

function thread(
  overrides: Partial<ThreadSummary> & Pick<ThreadSummary, "id">,
): ThreadSummary {
  return {
    workspace_id: workspace.id,
    title: overrides.id,
    provider: "codex",
    status: "idle",
    updated_at: new Date().toISOString(),
    last_message_preview: null,
    latest_turn_id: null,
    latest_plan: null,
    latest_diff: null,
    last_tool: null,
    last_error: null,
    agent: {},
    attention: {
      level: "none",
      badge_label: null,
      unread: false,
      pending_approval_count: 0,
      pending_question_count: 0,
      last_agent_activity_seq: 0,
      last_read_seq: 0,
    },
    is_archived: false,
    is_pinned: false,
    is_pinned_in_project: false,
    goal: null,
    queued_turns: [],
    variant: null,
    ...overrides,
  } as ThreadSummary;
}

function request(threadId = "blocked"): InteractiveRequest {
  return {
    request_id: "request-1",
    workspace_id: workspace.id,
    thread_id: threadId,
    method: "command",
    kind: "approval",
    approval_decisions: ["allow", "deny"],
    title: "Run tests?",
    detail: "The agent wants to run the test suite.",
    command: "npm test",
    path: "/projects/falcon",
    turn_id: null,
    item_id: null,
    questions: [],
    created_at: "2026-08-13T09:00:00Z",
  };
}

function groups(threads: ThreadSummary[]): ProjectGroup[] {
  return [{ workspace, threads }];
}

const seen = { ...thread({ id: "base" }).attention, last_agent_activity_seq: 2 };

function renderInbox(overrides: Partial<ActivityInboxProps> = {}) {
  const props: ActivityInboxProps = {
    groups: groups([
      thread({ id: "blocked", title: "Blocked task", status: "running" }),
      thread({
        id: "ready",
        title: "Ready task",
        last_message_preview: "All done",
        attention: { ...seen, unread: true },
      }),
      thread({
        id: "read",
        title: "Read task",
        updated_at: new Date(Date.now() - 60_000).toISOString(),
        attention: { ...seen, last_read_seq: 2 },
      }),
    ]),
    interactiveRequests: [request("blocked")],
    selectedWorkspaceId: null,
    selectedThreadId: null,
    nowTick: 0,
    onPreviewThread: vi.fn(),
    onOpenThread: vi.fn(),
    onArchiveThread: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  const view = render(<ActivityInbox {...props} />);
  return { ...view, props };
}

function rowTitles() {
  return screen
    .getAllByRole("option")
    .map((row) => row.getAttribute("data-inbox-key"));
}

describe("ActivityInbox", () => {
  it("pins tasks that need a response above the dated feed", () => {
    renderInbox();
    const needsYou = screen.getByRole("group", { name: "Needs you" });
    expect(within(needsYou).getByText("Blocked task")).toBeTruthy();
    expect(within(needsYou).getByText("Approval: npm test")).toBeTruthy();
    const today = screen.getByRole("group", { name: "Today" });
    expect(within(today).getByText("Ready task")).toBeTruthy();
    expect(rowTitles()).toEqual([
      "workspace-1:blocked",
      "workspace-1:ready",
      "workspace-1:read",
    ]);
  });

  it("previews on click and arrow keys, opens on Enter", () => {
    const { props } = renderInbox({
      selectedWorkspaceId: workspace.id,
      selectedThreadId: "blocked",
    });
    fireEvent.click(screen.getByText("Ready task"));
    expect(props.onPreviewThread).toHaveBeenLastCalledWith(workspace.id, "ready");

    const list = screen.getByRole("listbox", { name: "Activity" });
    fireEvent.keyDown(list, { key: "j" });
    expect(props.onPreviewThread).toHaveBeenLastCalledWith(workspace.id, "ready");
    fireEvent.keyDown(list, { key: "Enter" });
    expect(props.onOpenThread).toHaveBeenCalledWith(workspace.id, "blocked");
    fireEvent.keyDown(list, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalled();
  });

  it("archives the open task with E and moves on to the next one", async () => {
    const { props } = renderInbox({
      selectedWorkspaceId: workspace.id,
      selectedThreadId: "ready",
    });
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Activity" }), {
      key: "e",
    });
    expect(props.onArchiveThread).toHaveBeenCalledWith(workspace.id, "ready");
    await waitFor(() =>
      expect(props.onPreviewThread).toHaveBeenCalledWith(workspace.id, "read"),
    );
  });

  it("does not advance when the archive fails", async () => {
    const onArchiveThread = vi.fn().mockRejectedValue(new Error("offline"));
    const { props } = renderInbox({
      selectedWorkspaceId: workspace.id,
      selectedThreadId: "ready",
      onArchiveThread,
    });
    fireEvent.click(screen.getByRole("button", { name: "Archive Ready task" }));
    await waitFor(() => expect(onArchiveThread).toHaveBeenCalled());
    await Promise.resolve();
    expect(props.onPreviewThread).not.toHaveBeenCalled();
  });

  it("keeps the open task visible under the Unread filter after it is read", () => {
    const unread = thread({
      id: "ready",
      title: "Ready task",
      attention: { ...seen, unread: true },
    });
    const { rerender, props } = renderInbox({
      groups: groups([unread]),
      interactiveRequests: [],
      selectedWorkspaceId: workspace.id,
      selectedThreadId: "ready",
    });
    fireEvent.click(screen.getByRole("radio", { name: /Unread/ }));
    expect(rowTitles()).toEqual(["workspace-1:ready"]);

    const read = { ...unread, attention: { ...seen, last_read_seq: 2 } };
    rerender(<ActivityInbox {...props} groups={groups([read])} />);
    expect(rowTitles()).toEqual(["workspace-1:ready"]);

    rerender(
      <ActivityInbox {...props} groups={groups([read])} selectedThreadId={null} />,
    );
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("Nothing unread.")).toBeTruthy();
  });
});

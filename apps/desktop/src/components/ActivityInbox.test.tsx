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

  it("archives the open task with E and moves on once it leaves the list", () => {
    const { props, rerender } = renderInbox({
      selectedWorkspaceId: workspace.id,
      selectedThreadId: "ready",
    });
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Activity" }), {
      key: "e",
    });
    expect(props.onArchiveThread).toHaveBeenCalledWith(workspace.id, "ready");

    // The host clears the selection first; the snapshot lands after.
    rerender(<ActivityInbox {...props} selectedThreadId={null} />);
    expect(props.onPreviewThread).not.toHaveBeenCalled();

    const archived = props.groups[0]!.threads.map((candidate) =>
      candidate.id === "ready" ? { ...candidate, is_archived: true } : candidate,
    );
    rerender(
      <ActivityInbox
        {...props}
        groups={groups(archived)}
        selectedThreadId={null}
      />,
    );
    expect(props.onPreviewThread).toHaveBeenCalledWith(workspace.id, "read");
  });

  it("moves on to the next visible task, not one the filter hides", () => {
    const tasks = [
      thread({ id: "first", attention: { ...seen, unread: true } }),
      thread({
        id: "read",
        updated_at: new Date(Date.now() - 60_000).toISOString(),
        attention: { ...seen, last_read_seq: 2 },
      }),
      thread({
        id: "second",
        updated_at: new Date(Date.now() - 120_000).toISOString(),
        attention: { ...seen, unread: true },
      }),
    ];
    const { props, rerender } = renderInbox({
      groups: groups(tasks),
      interactiveRequests: [],
      selectedWorkspaceId: workspace.id,
      selectedThreadId: "first",
    });
    fireEvent.click(screen.getByRole("radio", { name: /Unread/ }));
    rerender(<ActivityInbox {...props} selectedThreadId={null} />);
    rerender(
      <ActivityInbox
        {...props}
        groups={groups([{ ...tasks[0]!, is_archived: true }, tasks[1]!, tasks[2]!])}
        selectedThreadId={null}
      />,
    );
    expect(props.onPreviewThread).toHaveBeenCalledWith(workspace.id, "second");
  });

  it("does not move on when the selection clears without an archive", () => {
    const { props, rerender } = renderInbox({
      selectedWorkspaceId: workspace.id,
      selectedThreadId: "ready",
    });
    rerender(<ActivityInbox {...props} selectedThreadId={null} />);
    rerender(
      <ActivityInbox
        {...props}
        groups={groups([...props.groups[0]!.threads])}
        selectedThreadId={null}
      />,
    );
    expect(props.onPreviewThread).not.toHaveBeenCalled();
  });

  it("archives from the row button without moving on by itself", async () => {
    const onArchiveThread = vi.fn().mockRejectedValue(new Error("offline"));
    const { props } = renderInbox({
      selectedWorkspaceId: workspace.id,
      selectedThreadId: "ready",
      onArchiveThread,
    });
    fireEvent.click(screen.getByRole("button", { name: "Archive Ready task" }));
    await waitFor(() => expect(onArchiveThread).toHaveBeenCalled());
    expect(props.onPreviewThread).not.toHaveBeenCalled();
  });

  it("points the list at the open task for assistive tech", () => {
    renderInbox({ selectedWorkspaceId: workspace.id, selectedThreadId: "ready" });
    const list = screen.getByRole("listbox", { name: "Activity" });
    const active = document.getElementById(
      list.getAttribute("aria-activedescendant") ?? "",
    );
    expect(active?.getAttribute("data-inbox-key")).toBe("workspace-1:ready");
  });

  it("keeps an answered task in its Needs you slot while it is open", () => {
    const blocked = (id: string) => thread({ id, title: id, status: "running" });
    const ask = (id: string, minute: number) => ({
      ...request(id),
      request_id: `request-${id}`,
      created_at: `2026-08-13T09:0${minute}:00Z`,
    });
    const { props, rerender } = renderInbox({
      groups: groups([blocked("one"), blocked("two"), blocked("three")]),
      interactiveRequests: [ask("one", 1), ask("two", 2), ask("three", 3)],
      selectedWorkspaceId: workspace.id,
      selectedThreadId: "two",
    });
    expect(rowTitles()).toEqual([
      "workspace-1:one",
      "workspace-1:two",
      "workspace-1:three",
    ]);
    // Answered: "two" is now just running, which would drop it to the feed.
    rerender(
      <ActivityInbox
        {...props}
        interactiveRequests={[ask("one", 1), ask("three", 3)]}
      />,
    );
    const needsYou = screen.getByRole("group", { name: "Needs you" });
    expect(
      within(needsYou)
        .getAllByRole("option")
        .map((row) => row.getAttribute("data-inbox-key")),
    ).toEqual(["workspace-1:one", "workspace-1:two", "workspace-1:three"]);

    fireEvent.click(screen.getByRole("radio", { name: /Running/ }));
    expect(rowTitles()).toEqual(["workspace-1:two"]);
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

  it("keeps a streaming task in place and lifts it when the turn ends", () => {
    const minutesAgo = (minutes: number) =>
      new Date(Date.now() - minutes * 60_000).toISOString();
    const newer = thread({
      id: "newer",
      updated_at: minutesAgo(1),
      attention: { ...seen, last_read_seq: 2 },
    });
    const working = thread({
      id: "working",
      status: "running",
      updated_at: minutesAgo(5),
      attention: { ...seen, level: "running" },
    });
    const { props, rerender } = renderInbox({
      groups: groups([newer, working]),
      interactiveRequests: [],
    });
    expect(rowTitles()).toEqual(["workspace-1:newer", "workspace-1:working"]);

    // Streaming bumps updated_at on every event; the row stays put.
    const streaming = { ...working, updated_at: new Date().toISOString() };
    rerender(<ActivityInbox {...props} groups={groups([newer, streaming])} />);
    expect(rowTitles()).toEqual(["workspace-1:newer", "workspace-1:working"]);

    // The turn ends with output the user has not read: new mail.
    const done = {
      ...streaming,
      status: "idle" as const,
      attention: { ...seen, last_agent_activity_seq: 3, unread: true },
    };
    rerender(<ActivityInbox {...props} groups={groups([newer, done])} />);
    expect(rowTitles()).toEqual(["workspace-1:working", "workspace-1:newer"]);
  });

  it("does not move the open task when its own activity lands", () => {
    const minutesAgo = (minutes: number) =>
      new Date(Date.now() - minutes * 60_000).toISOString();
    const top = thread({
      id: "top",
      updated_at: minutesAgo(1),
      attention: { ...seen, last_read_seq: 2 },
    });
    const open = thread({
      id: "open",
      updated_at: minutesAgo(10),
      attention: { ...seen, last_read_seq: 2 },
    });
    const { props, rerender } = renderInbox({
      groups: groups([top, open]),
      interactiveRequests: [],
      selectedWorkspaceId: workspace.id,
      selectedThreadId: "open",
    });
    const replied = {
      ...open,
      updated_at: new Date().toISOString(),
      attention: { ...seen, last_agent_activity_seq: 4, last_read_seq: 4 },
    };
    rerender(<ActivityInbox {...props} groups={groups([top, replied])} />);
    expect(rowTitles()).toEqual(["workspace-1:top", "workspace-1:open"]);

    // Moving on does not release it either: the user saw that turn.
    rerender(
      <ActivityInbox
        {...props}
        groups={groups([top, replied])}
        selectedThreadId="top"
      />,
    );
    expect(rowTitles()).toEqual(["workspace-1:top", "workspace-1:open"]);
  });

  it("holds the rows on screen while the pointer is over the list", () => {
    const first = thread({ id: "first", attention: { ...seen, unread: true } });
    const second = thread({
      id: "second",
      updated_at: new Date(Date.now() - 60_000).toISOString(),
      attention: { ...seen, unread: true },
    });
    const { props, rerender } = renderInbox({
      groups: groups([first, second]),
      interactiveRequests: [],
      selectedWorkspaceId: workspace.id,
      selectedThreadId: "first",
    });
    fireEvent.click(screen.getByRole("radio", { name: /Unread/ }));
    const list = screen.getByRole("listbox", { name: "Activity" });
    fireEvent.pointerEnter(list);

    // "first" was read and the user moved on to "second".
    const read = { ...first, attention: { ...seen, last_read_seq: 2 } };
    const fresh = thread({
      id: "fresh",
      updated_at: new Date(Date.now() + 1_000).toISOString(),
      attention: { ...seen, unread: true },
    });
    rerender(
      <ActivityInbox
        {...props}
        groups={groups([read, second, fresh])}
        selectedThreadId="second"
      />,
    );
    expect(rowTitles()).toEqual(["workspace-1:first", "workspace-1:second"]);

    fireEvent.pointerLeave(list);
    expect(rowTitles()).toEqual(["workspace-1:fresh", "workspace-1:second"]);
  });

  it("strips the scheduler envelope and markdown from previews", () => {
    renderInbox({
      groups: groups([
        thread({
          id: "auto",
          last_message_preview:
            "<falcondeck_automation>Sent by scheduled task</falcondeck_automation>\n**Audit** done in `main`",
          attention: { ...seen, unread: true },
        }),
      ]),
      interactiveRequests: [],
    });
    expect(screen.getByText("Audit done in main")).toBeTruthy();
  });
});

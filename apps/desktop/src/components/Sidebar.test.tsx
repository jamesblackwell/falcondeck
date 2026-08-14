import React from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import type {
  ExtensionSnapshot,
  ProjectGroup,
  ThreadSummary,
  WorkspaceSummary,
} from "@falcondeck/client-core";
import { deriveExtensionSidebarFilters } from "@falcondeck/client-core";

import { DesktopSidebar } from "./Sidebar";

function workspace(
  overrides: Partial<WorkspaceSummary> = {},
): WorkspaceSummary {
  return {
    id: "workspace-1",
    path: "/Users/james/falcondeck",
    status: "ready",
    agents: [],
    default_provider: "codex",
    models: [],
    collaboration_modes: [],
    account: { status: "ready", label: "ready" },
    current_thread_id: "thread-1",
    connected_at: "2026-03-15T10:00:00Z",
    updated_at: "2026-03-15T10:00:00Z",
    last_error: null,
    ...overrides,
  };
}

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: "thread-1",
    workspace_id: "workspace-1",
    title: "Main thread",
    provider: "codex",
    native_session_id: null,
    status: "idle",
    updated_at: "2026-03-15T10:00:00Z",
    last_message_preview: null,
    latest_turn_id: null,
    latest_plan: null,
    latest_diff: null,
    last_tool: null,
    last_error: null,
    is_archived: false,
    is_pinned: false,
    goal: null,
    agent: {
      model_id: null,
      reasoning_effort: null,
      collaboration_mode_id: null,
      approval_policy: null,
      service_tier: null,
    },
    attention: {
      level: "none",
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

function renderSidebar(
  overrides: Partial<ComponentProps<typeof DesktopSidebar>> = {},
  threadOverrides: Partial<ThreadSummary> = {},
) {
  const groups: ProjectGroup[] = [
    {
      workspace: workspace(),
      threads: [thread(threadOverrides)],
    },
  ];

  const onRenameThread = vi.fn().mockResolvedValue(undefined);
  const onArchiveThread = vi.fn().mockResolvedValue(undefined);
  const onDeleteThread = vi.fn().mockResolvedValue(undefined);
  const onRemoveWorkspace = vi.fn().mockResolvedValue(undefined);

  const rendered = render(
    <DesktopSidebar
      groups={groups}
      selectedWorkspaceId="workspace-1"
      selectedThreadId="thread-1"
      onSelectWorkspace={() => {}}
      onSelectThread={() => {}}
      onRenameThread={onRenameThread}
      onArchiveThread={onArchiveThread}
      onDeleteThread={onDeleteThread}
      onRemoveWorkspace={onRemoveWorkspace}
      {...overrides}
    />,
  );

  const rerenderSidebar = (
    nextOverrides: Partial<ComponentProps<typeof DesktopSidebar>>,
  ) => {
    rendered.rerender(
      <DesktopSidebar
        groups={groups}
        selectedWorkspaceId="workspace-1"
        selectedThreadId="thread-1"
        onSelectWorkspace={() => {}}
        onSelectThread={() => {}}
        onRenameThread={onRenameThread}
        onArchiveThread={onArchiveThread}
        onDeleteThread={onDeleteThread}
        onRemoveWorkspace={onRemoveWorkspace}
        {...overrides}
        {...nextOverrides}
      />,
    );
  };

  return {
    onRenameThread,
    onArchiveThread,
    onDeleteThread,
    onRemoveWorkspace,
    rerenderSidebar,
  };
}

describe("DesktopSidebar", () => {
  it("renders Activity above Scheduled with a failure-toned numeric badge", () => {
    const onOpenActivity = vi.fn();
    renderSidebar({
      onOpenActivity,
      activityOpen: true,
      activityCount: 3,
      activityHasFailure: true,
      onOpenScheduled: vi.fn(),
    });

    const activity = screen.getByRole("button", { name: "Activity" });
    const scheduled = screen.getByRole("button", { name: "Scheduled" });
    expect(activity.getAttribute("aria-current")).toBe("page");
    expect(activity).toHaveTextContent("3");
    expect(activity.querySelector(".text-danger")).not.toBeNull();
    expect(activity.compareDocumentPosition(scheduled)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    fireEvent.click(activity);
    expect(onOpenActivity).toHaveBeenCalledOnce();
  });

  it("detaches Activity from the row without opening the takeover", () => {
    const onOpenActivity = vi.fn();
    const onPopOutActivity = vi.fn();
    renderSidebar({ onOpenActivity, onPopOutActivity, activityCount: 2 });

    fireEvent.click(
      screen.getByRole("button", { name: "Open Activity in a new window" }),
    );
    expect(onPopOutActivity).toHaveBeenCalledOnce();
    expect(onOpenActivity).not.toHaveBeenCalled();
  });

  it("offers no detach affordance outside the desktop app", () => {
    renderSidebar({ onOpenActivity: vi.fn(), activityCount: 2 });

    expect(
      screen.queryByRole("button", { name: "Open Activity in a new window" }),
    ).not.toBeInTheDocument();
  });

  it("opens search from the header and adds projects from the Projects heading", () => {
    const onSearch = vi.fn();
    const onAddProject = vi.fn();
    renderSidebar({ onSearch, onAddProject, onNewThread: vi.fn() });

    const search = screen.getByRole("button", { name: "Search" });
    const addProject = screen.getByRole("button", { name: "Add project" });
    const projects = screen.getByRole("region", { name: "Projects" });
    // Search sits in the header; adding a project lives with the projects.
    expect(search.compareDocumentPosition(projects)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(projects).toContainElement(addProject);

    fireEvent.click(search);
    expect(onSearch).toHaveBeenCalledOnce();
    fireEvent.click(addProject);
    expect(onAddProject).toHaveBeenCalledOnce();
  });

  it("starts a thread from a row above every other navigation", () => {
    const onNewThread = vi.fn();
    renderSidebar({ onNewThread, onOpenActivity: vi.fn() });

    const newThread = screen.getByRole("button", { name: "New thread" });
    const activity = screen.getByRole("button", { name: "Activity" });
    expect(newThread.compareDocumentPosition(activity)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    fireEvent.click(newThread);
    expect(onNewThread).toHaveBeenCalledWith("workspace-1");
  });

  it("keeps the new-thread row usable before a project is selected", () => {
    const onNewThread = vi.fn();
    renderSidebar({
      onNewThread,
      selectedWorkspaceId: null,
      selectedThreadId: null,
    });

    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(onNewThread).toHaveBeenCalledWith("workspace-1");
  });

  it("renders Scheduled as first-class navigation above Projects", () => {
    const onOpenScheduled = vi.fn();
    renderSidebar({ onOpenScheduled, scheduledOpen: true });

    const scheduled = screen.getByRole("button", { name: "Scheduled" });
    const projects = screen.getByRole("region", { name: "Projects" });
    expect(scheduled.getAttribute("aria-current")).toBe("page");
    expect(scheduled.compareDocumentPosition(projects)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    fireEvent.click(scheduled);
    expect(onOpenScheduled).toHaveBeenCalledOnce();
  });

  it("shows scheduled-task attention without changing the navigation name", () => {
    renderSidebar({ onOpenScheduled: vi.fn(), scheduledAttention: true });
    expect(screen.getByRole("button", { name: "Scheduled" })).toContainElement(
      screen.getByTitle("Scheduled tasks need attention"),
    );
  });

  it("selects a thread when clicking anywhere in its highlighted row", () => {
    const onSelectThread = vi.fn();
    renderSidebar(
      {
        selectedThreadId: null,
        onSelectThread,
      },
      {
        updated_at: new Date().toISOString(),
      },
    );

    fireEvent.click(screen.getByText("now"));

    expect(onSelectThread).toHaveBeenCalledWith("workspace-1", "thread-1");
  });

  it("clearly marks a turn that stopped when FalconDeck closed", () => {
    renderSidebar(
      {},
      {
        status: "error",
        last_error: "FalconDeck was closed while this turn was running",
      },
    );

    expect(
      screen.getByRole("img", { name: "Stopped when FalconDeck closed" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Stopped")).toBeInTheDocument();
  });

  it("shows pinned chats above projects without duplicating them in their project", () => {
    const onSelectThread = vi.fn();
    renderSidebar({
      groups: [
        {
          workspace: workspace(),
          threads: [
            thread({
              id: "pinned-thread",
              title: "Pinned chat",
              is_pinned: true,
            }),
            thread({ id: "regular-thread", title: "Project chat" }),
          ],
        },
      ],
      selectedThreadId: "regular-thread",
      onSelectThread,
    });

    const pinnedSection = screen.getByRole("region", { name: "Pinned" });
    const projectsSection = screen.getByRole("region", { name: "Projects" });

    expect(pinnedSection.compareDocumentPosition(projectsSection)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(within(pinnedSection).getByText("Pinned chat")).toBeInTheDocument();
    expect(
      within(projectsSection).queryByText("Pinned chat"),
    ).not.toBeInTheDocument();
    expect(
      within(projectsSection).getByText("Project chat"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Pinned chat")).toHaveLength(1);

    fireEvent.click(within(pinnedSection).getByText("Pinned chat"));
    expect(onSelectThread).toHaveBeenCalledWith("workspace-1", "pinned-thread");
  });

  it("sorts each project’s chats by name when asked", () => {
    renderSidebar({
      groups: [
        {
          workspace: workspace(),
          threads: [
            thread({
              id: "thread-b",
              title: "Beta chat",
              updated_at: "2026-03-15T12:00:00Z",
            }),
            thread({
              id: "thread-a",
              title: "Alpha chat",
              updated_at: "2026-03-15T09:00:00Z",
            }),
          ],
        },
      ],
      threadSort: "alphabetical",
      onThreadSortChange: vi.fn(),
    });

    const projectsSection = screen.getByRole("region", { name: "Projects" });
    const alpha = within(projectsSection).getByText("Alpha chat");
    const beta = within(projectsSection).getByText("Beta chat");
    expect(alpha.compareDocumentPosition(beta)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("puts chats waiting on the user first when sorting by priority", () => {
    renderSidebar({
      groups: [
        {
          workspace: workspace(),
          threads: [
            thread({
              id: "thread-idle",
              title: "Idle chat",
              updated_at: "2026-03-15T12:00:00Z",
            }),
            thread({
              id: "thread-waiting",
              title: "Waiting chat",
              updated_at: "2026-03-15T09:00:00Z",
              attention: {
                level: "awaiting_response",
                badge_label: "Awaiting response",
                unread: false,
                pending_approval_count: 1,
                pending_question_count: 0,
                last_agent_activity_seq: 0,
                last_read_seq: 0,
              },
            }),
          ],
        },
      ],
      threadSort: "priority",
      onThreadSortChange: vi.fn(),
    });

    const projectsSection = screen.getByRole("region", { name: "Projects" });
    const waiting = within(projectsSection).getByText("Waiting chat");
    const idle = within(projectsSection).getByText("Idle chat");
    expect(waiting.compareDocumentPosition(idle)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("keeps Priority rows stable when snapshot timestamps churn", () => {
    const alpha = thread({
      id: "alpha",
      title: "Alpha",
      status: "running",
      updated_at: "2026-03-15T11:00:00Z",
    });
    const beta = thread({
      id: "beta",
      title: "Beta",
      status: "running",
      updated_at: "2026-03-15T10:00:00Z",
    });
    const baseProps = {
      selectedWorkspaceId: "workspace-1",
      selectedThreadId: null,
      onSelectWorkspace: vi.fn(),
      onSelectThread: vi.fn(),
      threadSort: "priority" as const,
    };
    const { rerender } = render(
      <DesktopSidebar
        {...baseProps}
        groups={[{ workspace: workspace(), threads: [alpha, beta] }]}
      />,
    );
    const projects = screen.getByRole("region", { name: "Projects" });
    expect(
      within(projects)
        .getByText("Alpha")
        .compareDocumentPosition(within(projects).getByText("Beta")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    rerender(
      <DesktopSidebar
        {...baseProps}
        groups={[
          {
            workspace: workspace(),
            threads: [{ ...beta, updated_at: "2026-03-15T12:00:00Z" }, alpha],
          },
        ]}
      />,
    );

    expect(
      within(projects)
        .getByText("Alpha")
        .compareDocumentPosition(within(projects).getByText("Beta")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("promotes attention immediately but defers selected-row demotion until navigation", () => {
    const quiet = thread({ id: "quiet", title: "Quiet" });
    const active = thread({ id: "active", title: "Active", status: "running" });
    const selectedBlocked = thread({
      id: "selected",
      title: "Selected",
      attention: {
        ...thread().attention,
        level: "awaiting_response",
        pending_approval_count: 1,
      },
    });
    const common = {
      selectedWorkspaceId: "workspace-1",
      onSelectWorkspace: vi.fn(),
      onSelectThread: vi.fn(),
      threadSort: "priority" as const,
    };
    const { rerender } = render(
      <DesktopSidebar
        {...common}
        selectedThreadId="selected"
        groups={[
          { workspace: workspace(), threads: [quiet, active, selectedBlocked] },
        ]}
      />,
    );
    const projects = screen.getByRole("region", { name: "Projects" });

    const promotedQuiet = {
      ...quiet,
      attention: {
        ...quiet.attention,
        level: "error" as const,
        unread: true,
      },
    };
    const readSelected = {
      ...selectedBlocked,
      attention: {
        ...selectedBlocked.attention,
        level: "none" as const,
        pending_approval_count: 0,
      },
    };
    rerender(
      <DesktopSidebar
        {...common}
        selectedThreadId="selected"
        groups={[
          {
            workspace: workspace(),
            threads: [promotedQuiet, active, readSelected],
          },
        ]}
      />,
    );

    expect(
      within(projects)
        .getByText("Selected")
        .compareDocumentPosition(within(projects).getByText("Quiet")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      within(projects)
        .getByText("Quiet")
        .compareDocumentPosition(within(projects).getByText("Active")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);

    rerender(
      <DesktopSidebar
        {...common}
        selectedThreadId="active"
        groups={[
          {
            workspace: workspace(),
            threads: [promotedQuiet, active, readSelected],
          },
        ]}
      />,
    );
    expect(
      within(projects)
        .getByText("Active")
        .compareDocumentPosition(within(projects).getByText("Selected")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("trails an out-of-window selected chat below the five most recent", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      thread({
        id: `thread-${index}`,
        title: `Chat ${index}`,
        // Descending recency: Chat 0 is newest, Chat 7 is oldest.
        updated_at: `2026-03-${String(20 - index).padStart(2, "0")}T10:00:00Z`,
      }),
    );

    renderSidebar({
      groups: [{ workspace: workspace(), threads }],
      selectedThreadId: "thread-7",
    });

    const projectsSection = screen.getByRole("region", { name: "Projects" });
    for (const index of [0, 1, 2, 3, 4]) {
      expect(
        within(projectsSection).getByText(`Chat ${index}`),
      ).toBeInTheDocument();
    }
    // The chats between the window and the selection stay hidden.
    expect(
      within(projectsSection).queryByText("Chat 5"),
    ).not.toBeInTheDocument();
    expect(
      within(projectsSection).queryByText("Chat 6"),
    ).not.toBeInTheDocument();
    expect(within(projectsSection).getByText("Chat 7")).toBeInTheDocument();

    fireEvent.click(within(projectsSection).getByText("Show more"));
    expect(within(projectsSection).getByText("Chat 5")).toBeInTheDocument();
    expect(within(projectsSection).getAllByText("Chat 7")).toHaveLength(1);

    // Winding the list back is available from the same row.
    fireEvent.click(within(projectsSection).getByText("Show less"));
    expect(
      within(projectsSection).queryByText("Chat 5"),
    ).not.toBeInTheDocument();
  });

  it("offers Show less beside Show more while a project is partly expanded", () => {
    const threads = Array.from({ length: 30 }, (_, index) =>
      thread({
        id: `thread-${index}`,
        title: `Chat ${index}`,
        updated_at: `2026-03-${String(30 - index).padStart(2, "0")}T10:00:00Z`,
      }),
    );

    render(
      <DesktopSidebar
        groups={[{ workspace: workspace(), threads }]}
        selectedWorkspaceId="workspace-1"
        selectedThreadId="thread-0"
        onSelectWorkspace={() => {}}
        onSelectThread={() => {}}
      />,
    );

    const projectsSection = screen.getByRole("region", { name: "Projects" });
    expect(
      within(projectsSection).queryByText("Show less"),
    ).not.toBeInTheDocument();

    fireEvent.click(within(projectsSection).getByText("Show more"));
    expect(within(projectsSection).getByText("Chat 14")).toBeInTheDocument();
    // Still more to page through, and now a way back.
    expect(within(projectsSection).getByText("Show more")).toBeInTheDocument();

    fireEvent.click(within(projectsSection).getByText("Show less"));
    expect(
      within(projectsSection).queryByText("Chat 14"),
    ).not.toBeInTheDocument();
  });

  it("keeps the five most recent chats visible after the selection moves back in", () => {
    const threads = Array.from({ length: 8 }, (_, index) =>
      thread({
        id: `thread-${index}`,
        title: `Chat ${index}`,
        updated_at: `2026-03-${String(20 - index).padStart(2, "0")}T10:00:00Z`,
      }),
    );
    const groups: ProjectGroup[] = [{ workspace: workspace(), threads }];

    const { rerender } = render(
      <DesktopSidebar
        groups={groups}
        selectedWorkspaceId="workspace-1"
        selectedThreadId="thread-7"
        onSelectWorkspace={() => {}}
        onSelectThread={() => {}}
      />,
    );

    rerender(
      <DesktopSidebar
        groups={groups}
        selectedWorkspaceId="workspace-1"
        selectedThreadId="thread-1"
        onSelectWorkspace={() => {}}
        onSelectThread={() => {}}
      />,
    );

    const projectsSection = screen.getByRole("region", { name: "Projects" });
    for (const index of [0, 1, 2, 3, 4]) {
      expect(
        within(projectsSection).getByText(`Chat ${index}`),
      ).toBeInTheDocument();
    }
    expect(
      within(projectsSection).queryByText("Chat 7"),
    ).not.toBeInTheDocument();
  });

  // Capturing on pointerdown retargets the follow-up click to the row, which
  // silently kills the collapse trigger nested inside it.
  it("captures the pointer only once a project drag passes the threshold", () => {
    const onWorkspaceOrderChange = vi.fn().mockResolvedValue(undefined);
    const project = workspace({
      id: "workspace-a",
      path: "/Users/james/alpha",
    });

    renderSidebar({
      groups: [
        { workspace: project, threads: [thread({ workspace_id: project.id })] },
      ],
      onWorkspaceOrderChange,
    });

    const row = document.querySelector(
      '[data-workspace-drag-id="workspace-a"]',
    ) as HTMLElement;
    const setPointerCapture = vi.fn();
    Object.defineProperty(row, "setPointerCapture", {
      value: setPointerCapture,
    });

    fireEvent.pointerDown(row, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    expect(setPointerCapture).not.toHaveBeenCalled();

    fireEvent.pointerMove(row, {
      pointerId: 1,
      isPrimary: true,
      clientX: 10,
      clientY: 60,
    });
    expect(setPointerCapture).toHaveBeenCalledWith(1);
  });

  it("collapses and expands a project when its row is clicked", () => {
    const project = workspace({
      id: "workspace-a",
      path: "/Users/james/alpha",
    });

    renderSidebar({
      groups: [
        {
          workspace: project,
          threads: [
            thread({
              workspace_id: project.id,
              id: "thread-a",
              title: "Alpha chat",
            }),
          ],
        },
      ],
      onWorkspaceOrderChange: vi.fn().mockResolvedValue(undefined),
    });

    const trigger = screen.getByRole("button", { name: "alpha" });
    expect(screen.getByText("Alpha chat")).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("collapses a project when clicking its drag row padding", () => {
    const project = workspace({
      id: "workspace-a",
      path: "/Users/james/alpha",
    });

    renderSidebar({
      groups: [
        {
          workspace: project,
          threads: [
            thread({
              workspace_id: project.id,
              id: "thread-a",
              title: "Alpha chat",
            }),
          ],
        },
      ],
      onWorkspaceOrderChange: vi.fn().mockResolvedValue(undefined),
    });

    const row = document.querySelector(
      '[data-workspace-drag-id="workspace-a"]',
    );
    if (!(row instanceof HTMLElement)) {
      throw new Error("Expected draggable workspace row");
    }

    fireEvent.click(row);

    expect(screen.queryByText("Alpha chat")).not.toBeInTheDocument();
  });

  it("reorders projects by dragging across the project rows", () => {
    const onWorkspaceOrderChange = vi.fn().mockResolvedValue(undefined);
    const first = workspace({ id: "workspace-a", path: "/Users/james/alpha" });
    const second = workspace({ id: "workspace-b", path: "/Users/james/beta" });

    renderSidebar({
      groups: [
        { workspace: first, threads: [thread({ workspace_id: first.id })] },
        {
          workspace: second,
          threads: [thread({ workspace_id: second.id, id: "thread-b" })],
        },
      ],
      onWorkspaceOrderChange,
    });

    const firstRow = document.querySelector(
      '[data-workspace-drag-id="workspace-a"]',
    );
    const secondRow = document.querySelector(
      '[data-workspace-drag-id="workspace-b"]',
    );
    if (
      !(firstRow instanceof HTMLElement) ||
      !(secondRow instanceof HTMLElement)
    ) {
      throw new Error("Expected draggable workspace rows");
    }
    Object.defineProperty(firstRow, "setPointerCapture", { value: vi.fn() });
    Object.defineProperty(firstRow, "hasPointerCapture", {
      value: vi.fn(() => true),
    });
    Object.defineProperty(firstRow, "releasePointerCapture", {
      value: vi.fn(),
    });
    Object.defineProperty(secondRow, "getBoundingClientRect", {
      value: () => ({
        top: 100,
        bottom: 140,
        height: 40,
        left: 0,
        right: 300,
        width: 300,
      }),
    });

    fireEvent.pointerDown(firstRow, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(firstRow, {
      pointerId: 1,
      isPrimary: true,
      clientX: 10,
      clientY: 150,
    });
    expect(
      document.querySelector('[data-workspace-drop-indicator="true"]'),
    ).toBeInTheDocument();
    fireEvent.pointerUp(firstRow, { pointerId: 1, isPrimary: true, button: 0 });

    expect(onWorkspaceOrderChange).toHaveBeenCalledWith([
      "workspace-b",
      "workspace-a",
    ]);
    expect(
      screen
        .getByText("beta")
        .compareDocumentPosition(screen.getByText("alpha")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("renders one insertion line between adjacent projects", () => {
    const onWorkspaceOrderChange = vi.fn();
    const groups = ["alpha", "beta", "charlie"].map((name) => {
      const project = workspace({
        id: `workspace-${name}`,
        path: `/Users/james/${name}`,
      });
      return {
        workspace: project,
        threads: [thread({ id: `thread-${name}`, workspace_id: project.id })],
      };
    });
    renderSidebar({ groups, onWorkspaceOrderChange });
    const alpha = document.querySelector(
      '[data-workspace-drag-id="workspace-alpha"]',
    ) as HTMLElement;
    const beta = document.querySelector(
      '[data-workspace-drag-id="workspace-beta"]',
    ) as HTMLElement;
    const charlie = document.querySelector(
      '[data-workspace-drag-id="workspace-charlie"]',
    ) as HTMLElement;
    Object.defineProperties(alpha, {
      setPointerCapture: { value: vi.fn() },
      hasPointerCapture: { value: vi.fn(() => true) },
      releasePointerCapture: { value: vi.fn() },
    });
    Object.defineProperty(beta, "getBoundingClientRect", {
      value: () => ({ top: 100, height: 40 }),
    });
    Object.defineProperty(charlie, "getBoundingClientRect", {
      value: () => ({ top: 200, height: 40 }),
    });

    fireEvent.pointerDown(alpha, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerMove(alpha, {
      pointerId: 1,
      isPrimary: true,
      clientX: 10,
      clientY: 150,
    });

    expect(
      document.querySelectorAll('[data-workspace-drop-indicator="true"]'),
    ).toHaveLength(1);
  });

  it("changes the chat sort from the Projects heading menu", async () => {
    const onThreadSortChange = vi.fn();
    renderSidebar({ threadSort: "last_updated", onThreadSortChange });

    fireEvent.click(screen.getByRole("button", { name: "Sort chats" }));

    const menu = await screen.findByRole("menu", { name: "Sort chats by" });
    expect(
      within(menu).getByRole("menuitemradio", { name: "Last updated" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(
      within(menu).getByRole("menuitemradio", { name: "Name" }),
    ).toHaveAttribute("aria-checked", "false");

    fireEvent.click(within(menu).getByRole("menuitemradio", { name: "Name" }));
    expect(onThreadSortChange).toHaveBeenCalledWith("alphabetical");
  });

  it("leaves the sort menu out when no sort handler is provided", () => {
    renderSidebar();

    expect(
      screen.queryByRole("button", { name: "Sort chats" }),
    ).not.toBeInTheDocument();
  });

  it("collapses a project to hide its threads, and selects it on the way back open", () => {
    const onSelectWorkspace = vi.fn();
    renderSidebar({ onSelectWorkspace });

    const toggle = screen.getByRole("button", { name: "falcondeck" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Main thread")).not.toBeInTheDocument();
    // Collapsing is not a selection change, so nothing should be re-selected.
    expect(onSelectWorkspace).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Main thread")).toBeInTheDocument();
    expect(onSelectWorkspace).toHaveBeenCalledWith("workspace-1", "thread-1");
  });

  it("collapses and expands every project from the Projects heading", () => {
    const groups: ProjectGroup[] = [
      {
        workspace: workspace(),
        threads: [thread()],
      },
      {
        workspace: workspace({
          id: "workspace-2",
          path: "/Users/james/second-project",
          current_thread_id: "thread-2",
        }),
        threads: [
          thread({
            id: "thread-2",
            workspace_id: "workspace-2",
            title: "Second thread",
          }),
        ],
      },
    ];
    renderSidebar({ groups });

    const collapseAll = screen.getByRole("button", {
      name: "Collapse all projects",
    });
    expect(collapseAll).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(collapseAll);
    expect(screen.queryByText("Main thread")).not.toBeInTheDocument();
    expect(screen.queryByText("Second thread")).not.toBeInTheDocument();

    const expandAll = screen.getByRole("button", {
      name: "Expand all projects",
    });
    expect(expandAll).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(expandAll);

    expect(screen.getByText("Main thread")).toBeInTheDocument();
    expect(screen.getByText("Second thread")).toBeInTheDocument();
  });

  it("honors a host-owned collapsed set and reports toggles back to it", () => {
    const onWorkspaceCollapsedChange = vi.fn();
    const { rerenderSidebar } = renderSidebar({
      collapsedWorkspaceIds: ["workspace-1"],
      onWorkspaceCollapsedChange,
    });

    const toggle = screen.getByRole("button", { name: /falcondeck/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Main thread")).not.toBeInTheDocument();
    // The row still accounts for what it is hiding.
    expect(toggle).toHaveTextContent("1");

    fireEvent.click(toggle);
    expect(onWorkspaceCollapsedChange).toHaveBeenCalledWith(
      "workspace-1",
      false,
    );
    // Controlled: the row only opens once the host says so.
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    rerenderSidebar({ collapsedWorkspaceIds: [] });
    expect(screen.getByRole("button", { name: /falcondeck/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("Main thread")).toBeInTheDocument();
  });

  it("renames a thread from the right-click menu", async () => {
    const { onRenameThread } = renderSidebar();

    fireEvent.contextMenu(screen.getByText("Main thread"));

    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    const input = await screen.findByRole("textbox", { name: "Thread title" });
    fireEvent.change(input, { target: { value: "Renamed thread" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onRenameThread).toHaveBeenCalledWith(
        "workspace-1",
        "thread-1",
        "Renamed thread",
      );
    });
  });

  it("renames a thread by double-clicking its row", async () => {
    const { onRenameThread } = renderSidebar();

    fireEvent.doubleClick(screen.getByText("Main thread"));

    const input = await screen.findByRole("textbox", { name: "Thread title" });
    fireEvent.change(input, { target: { value: "Renamed thread" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(onRenameThread).toHaveBeenCalledWith(
        "workspace-1",
        "thread-1",
        "Renamed thread",
      );
    });
  });

  it("archives a thread from the right-click menu", async () => {
    const { onArchiveThread } = renderSidebar();

    fireEvent.contextMenu(screen.getByText("Main thread"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));

    await waitFor(() => {
      expect(onArchiveThread).toHaveBeenCalledWith("workspace-1", "thread-1");
    });
  });

  it("deletes a thread from the right-click menu after confirmation", async () => {
    const { onDeleteThread } = renderSidebar();

    fireEvent.contextMenu(screen.getByText("Main thread"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Archiving keeps it out of the way");
    expect(onDeleteThread).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(onDeleteThread).toHaveBeenCalledWith("workspace-1", "thread-1");
    });
  });

  it("warns that deleting an isolated thread takes its checkout with it", async () => {
    renderSidebar(
      {},
      {
        variant: {
          slug: "fix-login",
          path: "/Users/james/.falcondeck/worktrees/fix-login",
          branch: "fd/fix-login",
          kind: "worktree",
        },
      },
    );

    fireEvent.contextMenu(screen.getByText("Main thread"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("deletes its isolated copy");
    expect(dialog).toHaveTextContent(
      "/Users/james/.falcondeck/worktrees/fix-login",
    );
    expect(dialog).toHaveTextContent(
      "committed work stays on branch fd/fix-login",
    );
  });

  it("leaves the delete item out when deletion is unavailable", () => {
    renderSidebar({ onDeleteThread: undefined });

    fireEvent.contextMenu(screen.getByText("Main thread"));

    expect(
      screen.queryByRole("menuitem", { name: "Delete" }),
    ).not.toBeInTheDocument();
  });

  it("sets a thread colour directly from the context menu", async () => {
    const onSetThreadColor = vi.fn().mockResolvedValue(undefined);
    const red = { id: "red", label: "Red", color: "red" };
    renderSidebar({
      threadTagOptions: [red],
      threadTagsById: { "thread-1": [red] },
      onSetThreadColor,
    });

    fireEvent.contextMenu(screen.getByText("Main thread"));
    const redChoice = await screen.findByRole("menuitemradio", { name: "Red" });
    expect(redChoice).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitemradio", { name: "No colour" }));
    await waitFor(() => {
      expect(onSetThreadColor).toHaveBeenCalledWith(
        "workspace-1",
        expect.objectContaining({ id: "thread-1" }),
        null,
      );
    });
  });

  it("hides thread colours when the owning daemon disables the extension", () => {
    const red = { id: "red", label: "Red", color: "red" };
    renderSidebar({
      threadTagOptions: [red],
      onSetThreadColor: vi.fn(),
      canSetThreadColor: (workspaceId) => workspaceId !== "workspace-1",
    });

    fireEvent.contextMenu(screen.getByText("Main thread"));

    expect(
      screen.queryByRole("menuitemradio", { name: "Red" }),
    ).not.toBeInTheDocument();
  });

  it("keeps colour filters in the Projects filter menu", async () => {
    const red = { id: "red", label: "Red", color: "red" };
    const blue = { id: "blue", label: "Blue", color: "blue" };
    renderSidebar({
      groups: [
        {
          workspace: workspace(),
          threads: [
            thread({ id: "red-thread", title: "Red thread" }),
            thread({ id: "blue-thread", title: "Blue thread" }),
          ],
        },
        {
          workspace: workspace({
            id: "workspace-2",
            path: "/Users/james/empty-project",
          }),
          threads: [
            thread({
              id: "untagged-thread",
              workspace_id: "workspace-2",
              title: "Untagged thread",
            }),
          ],
        },
      ],
      threadTagOptions: [red, blue],
      threadTagsById: {
        "red-thread": [red],
        "blue-thread": [blue],
      },
    });

    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Red" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Red thread")).toBeInTheDocument();
    expect(screen.getByText("Blue thread")).toBeInTheDocument();
    expect(screen.getByText("empty-project")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Filter chats by colour" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: "Red" }),
    );

    expect(screen.getByText("Red thread")).toBeInTheDocument();
    expect(screen.queryByText("Blue thread")).not.toBeInTheDocument();
    expect(screen.queryByText("empty-project")).not.toBeInTheDocument();
    expect(screen.queryByText("No threads yet")).not.toBeInTheDocument();
    expect(
      screen.getByTitle("Filter chats by colour (1 active)"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "Clear" }));
    expect(screen.getByText("Blue thread")).toBeInTheDocument();
    expect(screen.getByText("empty-project")).toBeInTheDocument();
  });

  it("renders and applies a generic extension sidebar filter", async () => {
    const extensions: ExtensionSnapshot = {
      catalog: [
        {
          id: "example.colors",
          name: "Example Colours",
          version: "1.0.0",
          source: "bundled",
          bundled: true,
          enabled: true,
          status: "active",
          contributes: {
            threadMenuActions: [],
            threadDecorations: [{ id: "chips", view: "thread-tags" }],
            sidebarFilters: [
              {
                id: "colors",
                title: "Colours",
                view: "tag-index",
                ui: {
                  version: 1,
                  root: {
                    type: "select",
                    id: "colors",
                    label: "Filter by colour",
                    multiple: true,
                    options: [{ value: "red", label: "Red", tone: "red" }],
                    binding: {
                      view: "thread-tags",
                      path: ["tagIds"],
                      operator: "includes_any",
                    },
                  },
                },
              },
            ],
          },
          permissions: [],
        },
      ],
      views: [
        {
          extension_id: "example.colors",
          view_id: "thread-tags",
          scope: { kind: "thread", id: "red-thread" },
          value: { tagIds: ["red"] },
          updated_at: "2026-08-13T00:00:00Z",
        },
      ],
    };
    renderSidebar({
      groups: [
        {
          workspace: workspace(),
          threads: [
            thread({ id: "red-thread", title: "Red thread" }),
            thread({ id: "plain-thread", title: "Plain thread" }),
          ],
        },
      ],
      extensionSnapshot: extensions,
      extensionSidebarFilters: deriveExtensionSidebarFilters(extensions),
    });

    fireEvent.click(screen.getByRole("button", { name: "Filter by colour" }));
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: "Red" }),
    );

    expect(screen.getByText("Red thread")).toBeInTheDocument();
    expect(screen.queryByText("Plain thread")).not.toBeInTheDocument();
  });

  it("composes colour and extension sidebar filters", async () => {
    const red = { id: "red", label: "Red", color: "red" };
    const blue = { id: "blue", label: "Blue", color: "blue" };
    const extensions: ExtensionSnapshot = {
      catalog: [
        {
          id: "example.priority",
          name: "Example Priority",
          version: "1.0.0",
          source: "bundled",
          bundled: true,
          enabled: true,
          status: "active",
          contributes: {
            threadMenuActions: [],
            threadDecorations: [],
            sidebarFilters: [
              {
                id: "priority",
                title: "Priority",
                view: "priority-index",
                ui: {
                  version: 1,
                  root: {
                    type: "select",
                    id: "priority",
                    label: "Filter by priority",
                    multiple: true,
                    options: [{ value: "hot", label: "Hot" }],
                    binding: {
                      view: "thread-priority",
                      path: ["labels"],
                      operator: "includes_any",
                    },
                  },
                },
              },
            ],
          },
          permissions: [],
        },
      ],
      views: [
        {
          extension_id: "example.priority",
          view_id: "thread-priority",
          scope: { kind: "thread", id: "red-hot" },
          value: { labels: ["hot"] },
          updated_at: "2026-08-13T00:00:00Z",
        },
        {
          extension_id: "example.priority",
          view_id: "thread-priority",
          scope: { kind: "thread", id: "blue-hot" },
          value: { labels: ["hot"] },
          updated_at: "2026-08-13T00:00:00Z",
        },
      ],
    };
    const { rerenderSidebar } = renderSidebar({
      groups: [
        {
          workspace: workspace(),
          threads: [
            thread({ id: "red-hot", title: "Red hot" }),
            thread({ id: "red-plain", title: "Red plain" }),
            thread({ id: "blue-hot", title: "Blue hot" }),
          ],
        },
      ],
      threadTagOptions: [red, blue],
      threadTagsById: {
        "red-hot": [red],
        "red-plain": [red],
        "blue-hot": [blue],
      },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Filter chats by colour" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: "Red" }),
    );

    rerenderSidebar({
      extensionSnapshot: extensions,
      extensionSidebarFilters: deriveExtensionSidebarFilters(extensions),
    });

    fireEvent.click(screen.getByRole("button", { name: "Filter by priority" }));
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: "Hot" }),
    );

    expect(screen.getByText("Red hot")).toBeInTheDocument();
    expect(screen.queryByText("Red plain")).not.toBeInTheDocument();
    expect(screen.queryByText("Blue hot")).not.toBeInTheDocument();
  });

  it("removes a project from the right-click menu after confirmation", async () => {
    const { onRemoveWorkspace } = renderSidebar();

    fireEvent.contextMenu(screen.getByText("falcondeck"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Remove project" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent(
      "Threads stay in the provider’s own history",
    );
    expect(onRemoveWorkspace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => {
      expect(onRemoveWorkspace).toHaveBeenCalledWith("workspace-1");
    });
  });

  it("focuses the context menu and moves through it with the arrow keys", async () => {
    renderSidebar();

    fireEvent.contextMenu(screen.getByText("Main thread"));
    const menu = await screen.findByRole("menu");
    const items = screen.getAllByRole("menuitem");

    // The menu opens from a right-click, so nothing moves focus into it
    // unless the menu does it itself.
    expect(items[0]).toHaveFocus();

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();

    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(items[0]).toHaveFocus();

    // Wraps, so ArrowUp from the first item lands on the last.
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(items[items.length - 1]).toHaveFocus();

    fireEvent.keyDown(menu, { key: "Home" });
    expect(items[0]).toHaveFocus();
  });

  it("moves focus into the delete dialog rather than leaving it on the body", async () => {
    renderSidebar();

    fireEvent.contextMenu(screen.getByText("Main thread"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));

    await screen.findByRole("dialog");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
  });

  it("leaves the project menu out when removal is unavailable", () => {
    renderSidebar({ onRemoveWorkspace: undefined });

    fireEvent.contextMenu(screen.getByText("falcondeck"));

    expect(
      screen.queryByRole("menuitem", { name: "Remove project" }),
    ).not.toBeInTheDocument();
  });
});

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
    is_pinned_in_project: false,
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

  it("renders Extensions directly beneath Activity", () => {
    const onOpenExtensions = vi.fn();
    renderSidebar({
      onOpenActivity: vi.fn(),
      onOpenExtensions,
      extensionsOpen: true,
      enabledExtensionCount: 2,
      onOpenScheduled: vi.fn(),
    });

    const activity = screen.getByRole("button", { name: "Activity" });
    const extensions = screen.getByRole("button", { name: "Extensions" });
    const scheduled = screen.getByRole("button", { name: "Scheduled" });
    expect(activity.compareDocumentPosition(extensions)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(extensions.compareDocumentPosition(scheduled)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(extensions).toHaveAttribute("aria-current", "page");
    expect(extensions).toHaveTextContent("2");

    fireEvent.click(extensions);
    expect(onOpenExtensions).toHaveBeenCalledOnce();
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
    expect(addProject).toHaveClass("text-fg-muted");
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

  it("keeps errors out of the titlebar row and lets them be dismissed", () => {
    const onDismissError = vi.fn();
    renderSidebar({
      onSearch: vi.fn(),
      onDismissError,
      errors: [
        "remote device revoke request failed with status 500 Internal Server Error",
      ],
    });

    const error = screen.getByText(/remote device revoke request failed/);
    // The header is a fixed-height drag region beside the traffic lights, so
    // a wrapped error there collided with the window controls.
    const search = screen.getByRole("button", { name: "Search" });
    expect(search.parentElement).not.toContainElement(error);
    expect(search.compareDocumentPosition(error)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(onDismissError).toHaveBeenCalledWith(
      "remote device revoke request failed with status 500 Internal Server Error",
    );
  });

  it("keeps an empty Chats section visible with its own new-chat action", () => {
    const onNewChat = vi.fn();
    renderSidebar({ onNewChat });

    const chats = screen.getByRole("region", { name: "Chats" });
    const projects = screen.getByRole("region", { name: "Projects" });
    const startChat = within(chats).getByRole("button", {
      name: "Start new chat",
    });
    expect(startChat).toHaveClass("text-fg-muted");

    expect(projects.compareDocumentPosition(chats)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    fireEvent.click(startChat);
    expect(onNewChat).toHaveBeenCalledOnce();
  });

  it("collapses the Chats section to hide individual chats", () => {
    const onNewChat = vi.fn();
    renderSidebar({
      onNewChat,
      groups: [
        {
          workspace: workspace({ id: "chat-w", kind: "casual" }),
          threads: [
            thread({
              id: "chat-t",
              workspace_id: "chat-w",
              title: "Weekend plans",
            }),
          ],
        },
      ],
    });

    expect(screen.getByText("Weekend plans")).toBeInTheDocument();
    const collapse = screen.getByRole("button", { name: "Collapse chats" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(collapse);
    expect(screen.queryByText("Weekend plans")).not.toBeInTheDocument();

    const expand = screen.getByRole("button", { name: "Expand chats" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(expand);
    expect(screen.getByText("Weekend plans")).toBeInTheDocument();
  });

  it("keeps the new-chat action available while chats are collapsed", () => {
    const onNewChat = vi.fn();
    renderSidebar({
      onNewChat,
      groups: [
        {
          workspace: workspace({ id: "chat-w", kind: "casual" }),
          threads: [
            thread({
              id: "chat-t",
              workspace_id: "chat-w",
              title: "Weekend plans",
            }),
          ],
        },
      ],
    });

    fireEvent.click(screen.getByRole("button", { name: "Collapse chats" }));
    expect(screen.queryByText("Weekend plans")).not.toBeInTheDocument();

    const chats = screen.getByRole("region", { name: "Chats" });
    fireEvent.click(
      within(chats).getByRole("button", { name: "Start new chat" }),
    );
    expect(onNewChat).toHaveBeenCalledOnce();
    expect(screen.queryByText("Weekend plans")).not.toBeInTheDocument();
  });

  it("honors a host-owned chats collapsed flag and reports toggles back to it", () => {
    const onChatsCollapsedChange = vi.fn();
    const groups: ProjectGroup[] = [
      {
        workspace: workspace({ id: "chat-w", kind: "casual" }),
        threads: [
          thread({
            id: "chat-t",
            workspace_id: "chat-w",
            title: "Weekend plans",
          }),
        ],
      },
    ];
    const { rerenderSidebar } = renderSidebar({
      groups,
      onNewChat: vi.fn(),
      chatsCollapsed: true,
      onChatsCollapsedChange,
    });

    expect(screen.queryByText("Weekend plans")).not.toBeInTheDocument();
    const expand = screen.getByRole("button", { name: "Expand chats" });
    expect(expand).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(expand);
    expect(onChatsCollapsedChange).toHaveBeenCalledWith(false);
    expect(screen.queryByText("Weekend plans")).not.toBeInTheDocument();

    rerenderSidebar({ chatsCollapsed: false, onChatsCollapsedChange });
    expect(screen.getByRole("button", { name: "Collapse chats" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("Weekend plans")).toBeInTheDocument();
  });

  it("searches one project's threads from the project row", () => {
    const onSearchProjectThreads = vi.fn();
    renderSidebar({ onSearchProjectThreads, onSearch: vi.fn() });

    fireEvent.click(
      screen.getByRole("button", { name: "Search threads in falcondeck" }),
    );

    expect(onSearchProjectThreads).toHaveBeenCalledWith("workspace-1");
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
              is_pinned_in_project: false,
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

  it("keeps pin-in-project chats at the top of their project instead of the global list", () => {
    renderSidebar({
      groups: [
        {
          workspace: workspace(),
          threads: [
            thread({
              id: "regular-new",
              title: "Newest project chat",
              updated_at: "2026-03-16T12:00:00Z",
            }),
            thread({
              id: "project-pinned",
              title: "Pinned in project",
              is_pinned_in_project: true,
              updated_at: "2026-03-10T10:00:00Z",
            }),
            thread({
              id: "regular-old",
              title: "Older project chat",
              updated_at: "2026-03-14T10:00:00Z",
            }),
          ],
        },
      ],
      selectedThreadId: "regular-new",
    });

    expect(screen.queryByRole("region", { name: "Pinned" })).not.toBeInTheDocument();
    const projectsSection = screen.getByRole("region", { name: "Projects" });
    const projectPinned = within(projectsSection).getByText("Pinned in project");
    const newest = within(projectsSection).getByText("Newest project chat");
    const older = within(projectsSection).getByText("Older project chat");

    expect(projectPinned.compareDocumentPosition(newest)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(newest.compareDocumentPosition(older)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(
      within(projectsSection).getByRole("img", { name: "Pinned in project" }),
    ).toBeInTheDocument();
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

  it("promotes attention immediately without reordering when selection changes", () => {
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
        .getByText("Selected")
        .compareDocumentPosition(within(projects).getByText("Quiet")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      within(projects)
        .getByText("Quiet")
        .compareDocumentPosition(within(projects).getByText("Active")),
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

  it("summarizes running and unread threads on a collapsed project row", () => {
    const groups: ProjectGroup[] = [
      {
        workspace: workspace(),
        threads: [
          thread({ id: "thread-1", title: "Running", status: "running" }),
          thread({ id: "thread-2", title: "Also running", status: "running" }),
          thread({
            id: "thread-3",
            title: "Unread",
            attention: {
              level: "none",
              badge_label: null,
              unread: false,
              pending_approval_count: 0,
              pending_question_count: 0,
              last_agent_activity_seq: 3,
              last_read_seq: 1,
            },
          }),
          thread({ id: "thread-4", title: "Quiet" }),
        ],
      },
    ];

    render(
      <DesktopSidebar
        groups={groups}
        selectedWorkspaceId="workspace-1"
        selectedThreadId="thread-1"
        collapsedWorkspaceIds={["workspace-1"]}
        onWorkspaceCollapsedChange={() => {}}
        onSelectWorkspace={() => {}}
        onSelectThread={() => {}}
      />,
    );

    const summary = screen.getByTitle("2 running \u00b7 1 unread");
    expect(summary).toHaveTextContent("2");
    expect(summary).toHaveTextContent("1");
  });

  it("leaves a collapsed project row blank when nothing needs attention", () => {
    renderSidebar({
      collapsedWorkspaceIds: ["workspace-1"],
      onWorkspaceCollapsedChange: () => {},
    });

    expect(screen.queryByText("running")).not.toBeInTheDocument();
    expect(screen.queryByText("unread")).not.toBeInTheDocument();
  });

  it("drops the summary once the project is expanded", () => {
    renderSidebar(
      { collapsedWorkspaceIds: [], onWorkspaceCollapsedChange: () => {} },
      { status: "running" },
    );

    expect(screen.queryByText("running")).not.toBeInTheDocument();
  });

  it("collapses the Projects section to hide every folder", () => {
    const onWorkspaceCollapsedChange = vi.fn();
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
    renderSidebar({
      groups,
      collapsedWorkspaceIds: ["workspace-2"],
      onWorkspaceCollapsedChange,
    });

    expect(screen.getByRole("button", { name: "falcondeck" })).toBeInTheDocument();
    expect(screen.getByText("Main thread")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "second-project" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Second thread")).not.toBeInTheDocument();

    const collapse = screen.getByRole("button", { name: "Collapse projects" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(collapse);

    expect(onWorkspaceCollapsedChange).not.toHaveBeenCalled();
    expect(
      screen.queryByRole("button", { name: "falcondeck" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "second-project" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Main thread")).not.toBeInTheDocument();

    const expand = screen.getByRole("button", { name: "Expand projects" });
    expect(expand).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(expand);

    expect(screen.getByRole("button", { name: "falcondeck" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("Main thread")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "second-project" }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Second thread")).not.toBeInTheDocument();
  });

  it("keeps the add-project action available while projects are collapsed", () => {
    const onAddProject = vi.fn();
    renderSidebar({ onAddProject });

    fireEvent.click(screen.getByRole("button", { name: "Collapse projects" }));
    expect(
      screen.queryByRole("button", { name: "falcondeck" }),
    ).not.toBeInTheDocument();

    const projects = screen.getByRole("region", { name: "Projects" });
    fireEvent.click(
      within(projects).getByRole("button", { name: "Add project" }),
    );
    expect(onAddProject).toHaveBeenCalledOnce();
    expect(
      screen.queryByRole("button", { name: "falcondeck" }),
    ).not.toBeInTheDocument();
  });

  it("honors a host-owned projects collapsed flag and reports toggles back to it", () => {
    const onProjectsCollapsedChange = vi.fn();
    const { rerenderSidebar } = renderSidebar({
      projectsCollapsed: true,
      onProjectsCollapsedChange,
    });

    expect(
      screen.queryByRole("button", { name: "falcondeck" }),
    ).not.toBeInTheDocument();
    const expand = screen.getByRole("button", { name: "Expand projects" });
    expect(expand).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(expand);
    expect(onProjectsCollapsedChange).toHaveBeenCalledWith(false);
    expect(
      screen.queryByRole("button", { name: "falcondeck" }),
    ).not.toBeInTheDocument();

    rerenderSidebar({ projectsCollapsed: false, onProjectsCollapsedChange });
    expect(
      screen.getByRole("button", { name: "Collapse projects" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "falcondeck" })).toBeInTheDocument();
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

  it("fills the rename field from a suggested title", async () => {
    const onSuggestThreadTitle = vi.fn().mockResolvedValue("Billing webhook");
    renderSidebar({ onSuggestThreadTitle });

    fireEvent.contextMenu(screen.getByText("Main thread"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Suggest title" }),
    );

    await waitFor(() => {
      expect(onSuggestThreadTitle).toHaveBeenCalledWith(
        "workspace-1",
        "thread-1",
      );
      expect(screen.getByRole("textbox", { name: "Thread title" })).toHaveValue(
        "Billing webhook",
      );
    });
  });

  it("forks a thread onto its own harness by default", async () => {
    const onForkThread = vi.fn().mockResolvedValue(undefined);
    renderSidebar({ onForkThread });

    fireEvent.contextMenu(screen.getByText("Main thread"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Fork thread" }));

    // Swapping harnesses is the point of the dialog, but the thread's own is
    // preselected so the old one-click behaviour survives as one keystroke.
    expect(await screen.findByRole("radio", { name: /Codex/ })).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    await waitFor(() => {
      expect(onForkThread).toHaveBeenCalledWith(
        "workspace-1",
        "thread-1",
        "codex",
      );
    });
  });

  it("forks a thread onto another harness when one is picked", async () => {
    const onForkThread = vi.fn().mockResolvedValue(undefined);
    renderSidebar({ onForkThread });

    fireEvent.contextMenu(screen.getByText("Main thread"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Fork thread" }));
    fireEvent.click(await screen.findByRole("radio", { name: /Claude/ }));
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    await waitFor(() => {
      expect(onForkThread).toHaveBeenCalledWith(
        "workspace-1",
        "thread-1",
        "claude",
      );
    });
  });

  it("forks without asking when the project offers one harness", async () => {
    const onForkThread = vi.fn().mockResolvedValue(undefined);
    renderSidebar({
      onForkThread,
      groups: [
        {
          workspace: workspace({
            agents: [
              {
                provider: "codex",
                label: "Codex",
                account: { status: "ready", label: "ready" },
                models: [],
                collaboration_modes: [],
              },
            ],
          }),
          threads: [thread()],
        },
      ],
    });

    fireEvent.contextMenu(screen.getByText("Main thread"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Fork thread" }));

    await waitFor(() => {
      expect(onForkThread).toHaveBeenCalledWith(
        "workspace-1",
        "thread-1",
        "codex",
      );
    });
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
  });

  it("keeps the fork dialog open and shows why a fork failed", async () => {
    const onForkThread = vi
      .fn()
      .mockRejectedValue(new Error("Nothing to fork yet"));
    renderSidebar({ onForkThread });

    fireEvent.contextMenu(screen.getByText("Main thread"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Fork thread" }));
    fireEvent.click(screen.getByRole("button", { name: "Fork" }));

    expect(await screen.findByText("Nothing to fork yet")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Fork" })).toBeInTheDocument();
  });

  it("archives a thread from the right-click menu after confirmation", async () => {
    const { onArchiveThread } = renderSidebar();

    fireEvent.contextMenu(screen.getByText("Main thread"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));

    // The first click only arms the row's Confirm pill.
    expect(onArchiveThread).not.toHaveBeenCalled();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Confirm archiving Main thread",
      }),
    );

    await waitFor(() => {
      expect(onArchiveThread).toHaveBeenCalledWith("workspace-1", "thread-1");
    });
  });

  it("asks for confirmation when the row's archive button is used", async () => {
    const { onArchiveThread } = renderSidebar();

    const archiveButton = screen.getByRole("button", {
      name: "Archive thread Main thread",
      hidden: true,
    });
    // The archive and timestamp occupy the same grid cell. Keep the action
    // above the timestamp so real pointer clicks reach the visible button.
    expect(archiveButton).toHaveClass(
      "invisible",
      "z-10",
      "focus-visible:visible",
      "group-hover:visible",
    );
    const timestamp = archiveButton.parentElement?.firstElementChild;
    // Visibility changes immediately while opacity animates, preventing the
    // timestamp from showing through the archive glyph during the reveal.
    expect(timestamp).toHaveClass(
      "group-hover:invisible",
      "group-focus-within/actions:invisible",
    );
    fireEvent.click(archiveButton);

    expect(onArchiveThread).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("button", {
        name: "Confirm archiving Main thread",
      }),
    ).toBeInTheDocument();
  });

  it("cancels the pending archive when clicking outside the row", async () => {
    renderSidebar();

    fireEvent.contextMenu(screen.getByText("Main thread"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    expect(
      await screen.findByRole("button", {
        name: "Confirm archiving Main thread",
      }),
    ).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    expect(
      screen.queryByRole("button", { name: "Confirm archiving Main thread" }),
    ).not.toBeInTheDocument();
  });

  it("cancels the pending archive on Escape", async () => {
    renderSidebar();

    fireEvent.contextMenu(screen.getByText("Main thread"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    expect(
      await screen.findByRole("button", {
        name: "Confirm archiving Main thread",
      }),
    ).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(
      screen.queryByRole("button", { name: "Confirm archiving Main thread" }),
    ).not.toBeInTheDocument();
  });

  it("cancels the pending archive when the dimmed row is clicked", async () => {
    renderSidebar();

    fireEvent.contextMenu(screen.getByText("Main thread"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive" }));
    expect(
      await screen.findByRole("button", {
        name: "Confirm archiving Main thread",
      }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText("Main thread"));

    expect(
      screen.queryByRole("button", { name: "Confirm archiving Main thread" }),
    ).not.toBeInTheDocument();
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

  it("sets a thread stage from the context-menu submenu", async () => {
    const onSetThreadStage = vi.fn().mockResolvedValue(undefined);
    const inProgress = {
      id: "in_progress",
      label: "In progress",
      color: "yellow",
      icon: "in_progress",
    };
    renderSidebar({
      threadTagOptions: [inProgress],
      threadTagsById: { "thread-1": [inProgress] },
      onSetThreadStage,
    });

    fireEvent.contextMenu(screen.getByText("Main thread"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Set stage" }));
    const current = await screen.findByRole("menuitemradio", {
      name: "In progress",
    });
    expect(current).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitemradio", { name: "No stage" }));
    await waitFor(() => {
      expect(onSetThreadStage).toHaveBeenCalledWith(
        "workspace-1",
        expect.objectContaining({ id: "thread-1" }),
        null,
      );
    });
  });

  it("creates a custom stage from the context-menu submenu", async () => {
    const onCreateThreadStage = vi.fn().mockResolvedValue(undefined);
    const backlog = {
      id: "backlog",
      label: "Backlog",
      color: "gray",
      icon: "backlog",
    };
    renderSidebar({
      threadTagOptions: [backlog],
      onSetThreadStage: vi.fn(),
      onCreateThreadStage,
    });

    fireEvent.contextMenu(screen.getByText("Main thread"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Set stage" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Add stage…" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("Add stage");
    fireEvent.change(screen.getByLabelText("Stage name"), {
      target: { value: "Blocked" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      expect(onCreateThreadStage).toHaveBeenCalledWith(
        "workspace-1",
        expect.objectContaining({ id: "thread-1" }),
        "Blocked",
      );
    });
  });

  it("keeps the context menu open while scrolling stage options", async () => {
    renderSidebar({
      threadTagOptions: [
        {
          id: "in_progress",
          label: "In progress",
          color: "yellow",
          icon: "in_progress",
        },
      ],
      onSetThreadStage: vi.fn(),
    });

    fireEvent.contextMenu(screen.getByText("Main thread"));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Set stage" }));
    const stageMenu = await screen.findByRole("menu", { name: "Set stage" });

    fireEvent.scroll(stageMenu);

    expect(stageMenu).toBeInTheDocument();
    expect(
      screen.getByRole("menuitemradio", { name: "In progress" }),
    ).toBeInTheDocument();
  });

  it("hides thread stages when the owning daemon disables the extension", () => {
    const inProgress = {
      id: "in_progress",
      label: "In progress",
      color: "yellow",
      icon: "in_progress",
    };
    renderSidebar({
      threadTagOptions: [inProgress],
      onSetThreadStage: vi.fn(),
      canSetThreadStage: (workspaceId) => workspaceId !== "workspace-1",
    });

    fireEvent.contextMenu(screen.getByText("Main thread"));

    expect(
      screen.queryByRole("menuitem", { name: "Set stage" }),
    ).not.toBeInTheDocument();
  });

  it("keeps stage filters in the Projects filter menu", async () => {
    const inProgress = {
      id: "in_progress",
      label: "In progress",
      color: "yellow",
      icon: "in_progress",
    };
    const done = { id: "done", label: "Done", color: "orange", icon: "done" };
    renderSidebar({
      groups: [
        {
          workspace: workspace(),
          threads: [
            thread({ id: "progress-thread", title: "Progress thread" }),
            thread({ id: "done-thread", title: "Done thread" }),
          ],
        },
        {
          workspace: workspace({
            id: "workspace-2",
            path: "/Users/james/empty-project",
          }),
          threads: [
            thread({
              id: "unstaged-thread",
              workspace_id: "workspace-2",
              title: "Unstaged thread",
            }),
          ],
        },
      ],
      threadTagOptions: [inProgress, done],
      threadTagsById: {
        "progress-thread": [inProgress],
        "done-thread": [done],
      },
    });

    expect(
      screen.queryByRole("menuitemcheckbox", { name: "In progress" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Progress thread")).toBeInTheDocument();
    expect(screen.getByText("Done thread")).toBeInTheDocument();
    expect(screen.getByText("empty-project")).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Filter chats by stage" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: "In progress" }),
    );

    expect(screen.getByText("Progress thread")).toBeInTheDocument();
    expect(screen.queryByText("Done thread")).not.toBeInTheDocument();
    expect(screen.queryByText("empty-project")).not.toBeInTheDocument();
    expect(screen.queryByText("No threads yet")).not.toBeInTheDocument();
    expect(
      screen.getByTitle("Filter chats by stage (1 active)"),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "Clear" }));
    expect(screen.getByText("Done thread")).toBeInTheDocument();
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

  it("composes stage and extension sidebar filters", async () => {
    const inProgress = {
      id: "in_progress",
      label: "In progress",
      color: "yellow",
      icon: "in_progress",
    };
    const done = { id: "done", label: "Done", color: "orange", icon: "done" };
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
      threadTagOptions: [inProgress, done],
      threadTagsById: {
        "red-hot": [inProgress],
        "red-plain": [inProgress],
        "blue-hot": [done],
      },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Filter chats by stage" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitemcheckbox", { name: "In progress" }),
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

  it("closes a project from the sidebar without forgetting it", async () => {
    const onCloseWorkspace = vi.fn().mockResolvedValue(undefined);
    renderSidebar({ onCloseWorkspace });

    fireEvent.contextMenu(screen.getByText("falcondeck"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Remove from Sidebar" }),
    );

    await waitFor(() => {
      expect(onCloseWorkspace).toHaveBeenCalledWith("workspace-1");
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("confirms closing a project that has a running turn", async () => {
    const onCloseWorkspace = vi.fn().mockResolvedValue(undefined);
    renderSidebar(
      {
        onCloseWorkspace,
        closeWorkspaceReason: () =>
          "This project has a running turn. Closing it stops that work until you add the project back.",
      },
      { status: "running" },
    );

    fireEvent.contextMenu(screen.getByText("falcondeck"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Remove from Sidebar" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("running turn");
    expect(onCloseWorkspace).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Remove from Sidebar" }),
    );
    await waitFor(() => {
      expect(onCloseWorkspace).toHaveBeenCalledWith("workspace-1");
    });
  });

  it("forgets a project from the right-click menu after confirmation", async () => {
    const { onRemoveWorkspace } = renderSidebar();

    fireEvent.contextMenu(screen.getByText("falcondeck"));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Forget project" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("FalconDeck will forget this project");
    expect(onRemoveWorkspace).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Forget" }));

    await waitFor(() => {
      expect(onRemoveWorkspace).toHaveBeenCalledWith("workspace-1");
    });
  });

  it("sets a project folder color from the right-click menu", async () => {
    const onWorkspaceColorChange = vi.fn().mockResolvedValue(undefined);
    renderSidebar({
      onWorkspaceColorChange,
      workspaceColors: { "workspace-1": "cat-2" },
    });

    fireEvent.contextMenu(screen.getByText("falcondeck"));
    expect(screen.getByRole("menuitemradio", { name: "Color 2" })).toHaveAttribute(
      "aria-checked",
      "true",
    );

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Color 5" }));
    expect(onWorkspaceColorChange).toHaveBeenCalledWith("workspace-1", "cat-5");

    fireEvent.contextMenu(screen.getByText("falcondeck"));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Default" }));
    expect(onWorkspaceColorChange).toHaveBeenCalledWith("workspace-1", null);
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

  it("reveals the thread's provider mark with the row without a tile", () => {
    renderSidebar({
      groups: [
        {
          workspace: workspace({
            agents: [
              {
                provider: "opencode",
                label: "OpenCode",
                account: { status: "ready", label: "ready" },
                models: [],
                collaboration_modes: [],
              },
            ],
          }),
          threads: [thread({ provider: "opencode" })],
        },
      ],
    });

    const mark = screen.getByTestId("thread-provider-mark");
    expect(mark).toHaveAccessibleName("OpenCode");
    expect(mark.className).toContain("opacity-0");
    expect(mark.className).toContain("group-hover:opacity-100");
    expect(mark.className).toContain("group-focus-within:opacity-100");
    expect(mark.className).not.toContain("bg-");
    expect(mark.className).toContain("@[13rem]:flex");
  });

  it("title-cases a provider the workspace has not advertised yet", () => {
    renderSidebar();

    expect(screen.getByTestId("thread-provider-mark")).toHaveAccessibleName(
      "Codex",
    );
  });

  it("leaves the project menu out when membership actions are unavailable", () => {
    renderSidebar({
      onRemoveWorkspace: undefined,
      onCloseWorkspace: undefined,
    });

    fireEvent.contextMenu(screen.getByText("falcondeck"));

    expect(
      screen.queryByRole("menuitem", { name: "Remove from Sidebar" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Forget project" }),
    ).not.toBeInTheDocument();
  });

  it("renders Options menu trigger in footer and triggers actions", () => {
    const onOpenSettings = vi.fn();
    const onOpenUsage = vi.fn();

    renderSidebar({
      onOpenSettings,
      onOpenUsage,
    });

    const optionsButton = screen.getByRole("button", { name: "Options" });
    expect(optionsButton).toBeInTheDocument();

    fireEvent.click(optionsButton);
    expect(screen.getByRole("menu", { name: "Options menu" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: /Usage/ }));
    expect(onOpenUsage).toHaveBeenCalledOnce();
  });
});

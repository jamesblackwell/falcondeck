import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  InteractiveRequest,
  ProjectGroup,
  ThreadSummary,
  WorkspaceSummary,
} from "@falcondeck/client-core";
import { ActivityView } from "@falcondeck/chat-ui/activity-view";

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

function props(
  overrides: Partial<React.ComponentProps<typeof ActivityView>> = {},
) {
  return {
    groups: groups([]),
    interactiveRequests: [],
    onOpenThread: vi.fn(),
    onInteractiveResponse: vi.fn().mockResolvedValue(undefined),
    onMarkThreadRead: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ActivityView", () => {
  it("renders all populated sections and their row details", () => {
    render(
      <ActivityView
        {...props({
          groups: groups([
            thread({ id: "blocked" }),
            thread({
              id: "failed",
              last_error: "Process exited 1",
              attention: {
                ...thread({ id: "base" }).attention,
                level: "error",
                unread: true,
              },
            }),
            thread({
              id: "ready",
              last_message_preview: "Implementation complete",
              attention: {
                ...thread({ id: "base" }).attention,
                level: "unread",
                unread: true,
              },
            }),
            thread({
              id: "running",
              status: "running",
              last_tool: "Running tests",
              attention: {
                ...thread({ id: "base" }).attention,
                level: "running",
              },
            }),
          ]),
          interactiveRequests: [request()],
        })}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Blocked" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Failed" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Ready for you" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Running" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Process exited 1")).toBeInTheDocument();
    expect(screen.getByText("Implementation complete")).toBeInTheDocument();
    expect(screen.getByText("Running tests")).toHaveClass("line-clamp-3");
    expect(
      document.querySelector('[data-activity-thread="running"]'),
    ).toHaveClass("h-36", "overflow-hidden");
    expect(
      document.querySelector('[data-activity-thread="blocked"]'),
    ).not.toHaveClass("h-36");
    expect(screen.getByLabelText("Activity summary")).toHaveTextContent(
      "3 need attention",
    );
    expect(screen.getByText("Needs response")).toBeInTheDocument();
    expect(
      document.querySelector('[data-activity-grid="running"]'),
    ).toHaveClass("lg:grid-cols-2", "2xl:grid-cols-3");
    expect(
      document.querySelector('[data-activity-grid="blocked"]'),
    ).not.toHaveClass("2xl:grid-cols-3");
  });

  it("answers an approval inline with the exact response payload", async () => {
    const onInteractiveResponse = vi.fn().mockResolvedValue(undefined);
    render(
      <ActivityView
        {...props({
          groups: groups([thread({ id: "blocked" })]),
          interactiveRequests: [request()],
          onInteractiveResponse,
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await waitFor(() =>
      expect(onInteractiveResponse).toHaveBeenCalledWith(
        expect.objectContaining({ request_id: "request-1" }),
        { kind: "approval", decision: "allow" },
      ),
    );
  });

  it("shows inline response errors from the existing request card", async () => {
    render(
      <ActivityView
        {...props({
          groups: groups([thread({ id: "blocked" })]),
          interactiveRequests: [request()],
          onInteractiveResponse: vi
            .fn()
            .mockRejectedValue(new Error("Host rejected the response")),
        })}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Host rejected the response",
    );
  });

  it("holds a resolved card briefly after the request leaves the snapshot", async () => {
    vi.useFakeTimers();
    const initial = props({
      groups: groups([thread({ id: "blocked" })]),
      interactiveRequests: [request()],
    });
    const { rerender } = render(<ActivityView {...initial} />);

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await act(async () => {});
    rerender(<ActivityView {...initial} interactiveRequests={[]} />);
    expect(screen.getByText("Resolved")).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1_500));
    expect(screen.queryByText("Run tests?")).not.toBeInTheDocument();
  });

  it("holds the resolved card when the thread immediately returns to running", async () => {
    vi.useFakeTimers();
    const initial = props({
      groups: groups([thread({ id: "blocked" })]),
      interactiveRequests: [request()],
    });
    const { rerender } = render(<ActivityView {...initial} />);

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await act(async () => {});
    rerender(
      <ActivityView
        {...initial}
        groups={groups([thread({ id: "blocked", status: "running" })])}
        interactiveRequests={[]}
      />,
    );
    expect(screen.getByText("Resolved")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Running" }),
    ).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1_500));
    expect(screen.queryByText("Resolved")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Running" }),
    ).toBeInTheDocument();
  });

  it("shows the next request immediately after resolving the first", async () => {
    vi.useFakeTimers();
    const first = request();
    const second = {
      ...request(),
      request_id: "request-2",
      title: "Deploy now?",
      created_at: "2026-08-13T09:01:00Z",
    };
    const initial = props({
      groups: groups([thread({ id: "blocked" })]),
      interactiveRequests: [first],
    });
    const { rerender } = render(<ActivityView {...initial} />);

    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    await act(async () => {});
    rerender(<ActivityView {...initial} interactiveRequests={[second]} />);

    expect(screen.getByText("Deploy now?")).toBeInTheDocument();
    expect(screen.queryByText("Resolved")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow" })).toBeEnabled();
  });

  it("keeps a blocked row in place when its next request takes over", async () => {
    vi.useFakeTimers();
    const first = request("first");
    const other = {
      ...request("other"),
      request_id: "request-other",
      title: "Other request",
      created_at: "2026-08-13T10:00:00Z",
    };
    const next = {
      ...request("first"),
      request_id: "request-next",
      title: "Next request",
      created_at: "2026-08-13T11:00:00Z",
    };
    const initial = props({
      groups: groups([thread({ id: "first" }), thread({ id: "other" })]),
      interactiveRequests: [first, other],
    });
    const { rerender } = render(<ActivityView {...initial} />);
    const firstRow = document.querySelector('[data-activity-thread="first"]')!;
    const otherRow = document.querySelector('[data-activity-thread="other"]')!;
    expect(firstRow.compareDocumentPosition(otherRow)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Allow" })[0]!);
    await act(async () => {});
    rerender(<ActivityView {...initial} interactiveRequests={[next, other]} />);

    expect(screen.getByText("Next request")).toBeInTheDocument();
    expect(firstRow.compareDocumentPosition(otherRow)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("marks Ready rows read only from the explicit action", () => {
    const onMarkThreadRead = vi.fn();
    render(
      <ActivityView
        {...props({
          groups: groups([
            thread({
              id: "ready",
              attention: {
                ...thread({ id: "base" }).attention,
                level: "unread",
                unread: true,
              },
            }),
          ]),
          onMarkThreadRead,
        })}
      />,
    );
    expect(onMarkThreadRead).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Mark read" }));
    expect(onMarkThreadRead).toHaveBeenCalledWith(workspace.id, "ready");
  });

  it("disables remote-host writes while the host is offline", () => {
    const onInteractiveResponse = vi.fn();
    const onMarkThreadRead = vi.fn();
    render(
      <ActivityView
        {...props({
          groups: groups([
            thread({ id: "blocked" }),
            thread({
              id: "ready",
              attention: {
                ...thread({ id: "base" }).attention,
                level: "unread",
                unread: true,
              },
            }),
          ]),
          interactiveRequests: [request()],
          workspaceHosts: {
            [workspace.id]: { name: "Studio Mac", connected: false },
          },
          onInteractiveResponse,
          onMarkThreadRead,
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "Allow" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Mark read" })).toBeDisabled();
    expect(screen.getAllByText("Studio Mac · Offline")).toHaveLength(2);
  });

  it("shows the caught-up state and optional new-thread affordance", () => {
    const onNewThread = vi.fn();
    render(<ActivityView {...props({ onNewThread })} />);
    expect(screen.getByText("All caught up")).toBeInTheDocument();
    expect(screen.getByText("No active work")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(onNewThread).toHaveBeenCalledOnce();
  });
});

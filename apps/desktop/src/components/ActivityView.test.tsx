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

  it("offers to detach into its own window, and drops the offer once detached", () => {
    const onPopOut = vi.fn();
    const { rerender } = render(
      <ActivityView {...props({ onPopOut })} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open in new window" }),
    );
    expect(onPopOut).toHaveBeenCalledOnce();

    // The detached window has the native frame for this, and nothing to
    // pop out of.
    rerender(<ActivityView {...props()} onClose={undefined} />);
    expect(
      screen.queryByRole("button", { name: "Open in new window" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Close Activity" }),
    ).not.toBeInTheDocument();
  });

  it("leaves a detached window open on Escape", () => {
    const onClose = vi.fn();
    render(<ActivityView {...props({ onClose })} onClose={undefined} />);

    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows the caught-up state and optional new-thread affordance", () => {
    const onNewThread = vi.fn();
    render(<ActivityView {...props({ onNewThread })} />);
    expect(screen.getByText("All caught up")).toBeInTheDocument();
    expect(screen.getByText("No active work")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New thread" }));
    expect(onNewThread).toHaveBeenCalledOnce();
  });

  describe("keyboard", () => {
    const queue = () =>
      groups([
        thread({
          id: "first",
          last_message_preview: "One",
          attention: {
            ...thread({ id: "base" }).attention,
            level: "unread",
            unread: true,
          },
        }),
        thread({
          id: "second",
          last_message_preview: "Two",
          attention: {
            ...thread({ id: "base" }).attention,
            level: "unread",
            unread: true,
          },
        }),
      ]);

    const selectedThreadId = () =>
      document
        .querySelector("[data-selected='true']")
        ?.getAttribute("data-activity-thread");

    it("moves through the queue with j/k and opens with Enter", () => {
      const onOpenThread = vi.fn();
      render(<ActivityView {...props({ groups: queue(), onOpenThread })} />);

      expect(selectedThreadId()).toBe("first");
      fireEvent.keyDown(window, { key: "j" });
      expect(selectedThreadId()).toBe("second");
      fireEvent.keyDown(window, { key: "k" });
      expect(selectedThreadId()).toBe("first");

      fireEvent.keyDown(window, { key: "Enter" });
      expect(onOpenThread).toHaveBeenCalledWith(workspace.id, "first");
    });

    it("follows the rendered card grid with the arrow keys", () => {
      const running = ["a", "b", "c", "d"].map((id) =>
        thread({
          id,
          status: "running",
          attention: {
            ...thread({ id: "base" }).attention,
            level: "running",
          },
        }),
      );
      render(<ActivityView {...props({ groups: groups(running) })} />);

      const positions = [[0, 0], [100, 0], [200, 0], [0, 100]];
      for (const [index, element] of Array.from(
        document.querySelectorAll<HTMLElement>("[data-activity-key]"),
      ).entries()) {
        const [left, top] = positions[index]!;
        element.getBoundingClientRect = vi.fn(() => ({
          left, top, width: 80, height: 60,
          right: left + 80, bottom: top + 60, x: left, y: top,
          toJSON: () => ({}),
        }));
      }

      expect(selectedThreadId()).toBe("a");
      fireEvent.keyDown(window, { key: "ArrowRight" });
      expect(selectedThreadId()).toBe("b");
      fireEvent.keyDown(window, { key: "ArrowLeft" });
      expect(selectedThreadId()).toBe("a");
      fireEvent.keyDown(window, { key: "ArrowDown" });
      expect(selectedThreadId()).toBe("d");
    });

    it("follows the rendered card grid with WASD", () => {
      const running = ["a", "b", "c", "d"].map((id) =>
        thread({
          id,
          status: "running",
          attention: {
            ...thread({ id: "base" }).attention,
            level: "running",
          },
        }),
      );
      render(<ActivityView {...props({ groups: groups(running) })} />);

      const positions = [[0, 0], [100, 0], [200, 0], [0, 100]];
      for (const [index, element] of Array.from(
        document.querySelectorAll<HTMLElement>("[data-activity-key]"),
      ).entries()) {
        const [left, top] = positions[index]!;
        element.getBoundingClientRect = vi.fn(() => ({
          left, top, width: 80, height: 60,
          right: left + 80, bottom: top + 60, x: left, y: top,
          toJSON: () => ({}),
        }));
      }

      expect(selectedThreadId()).toBe("a");
      fireEvent.keyDown(window, { key: "d" });
      expect(selectedThreadId()).toBe("b");
      fireEvent.keyDown(window, { key: "a" });
      expect(selectedThreadId()).toBe("a");
      fireEvent.keyDown(window, { key: "s" });
      expect(selectedThreadId()).toBe("d");
      fireEvent.keyDown(window, { key: "w" });
      expect(selectedThreadId()).toBe("a");
    });

    it("opens the selected thread with E", () => {
      const onOpenThread = vi.fn();
      render(<ActivityView {...props({ groups: queue(), onOpenThread })} />);

      fireEvent.keyDown(window, { key: "e" });
      expect(onOpenThread).toHaveBeenCalledWith(workspace.id, "first");
    });

    it("jumps to a lane with its digit", () => {
      const running = thread({
        id: "busy",
        status: "running",
        attention: { ...thread({ id: "base" }).attention, level: "running" },
      });
      render(
        <ActivityView
          {...props({ groups: groups([...queue()[0]!.threads, running]) })}
        />,
      );

      // 3 is "ready for you", 4 is "running"; 1 and 2 are empty here.
      fireEvent.keyDown(window, { key: "4" });
      expect(selectedThreadId()).toBe("busy");
      fireEvent.keyDown(window, { key: "3" });
      expect(selectedThreadId()).toBe("first");
      fireEvent.keyDown(window, { key: "1" });
      expect(selectedThreadId()).toBe("first");
    });

    it.each(["q", "r"])("clears the selected thread with %s", (key) => {
      const onMarkThreadRead = vi.fn();
      render(
        <ActivityView {...props({ groups: queue(), onMarkThreadRead })} />,
      );

      fireEvent.keyDown(window, { key });
      expect(onMarkThreadRead).toHaveBeenCalledWith(workspace.id, "first");
    });

    it("leaves the keys alone while the user is typing or holding a modifier", () => {
      const onOpenThread = vi.fn();
      render(<ActivityView {...props({ groups: queue(), onOpenThread })} />);

      const input = document.createElement("input");
      document.body.appendChild(input);
      fireEvent.keyDown(input, { key: "j" });
      expect(selectedThreadId()).toBe("first");
      input.remove();

      fireEvent.keyDown(window, { key: "j", metaKey: true });
      expect(selectedThreadId()).toBe("first");
    });

    it("steps Escape back through selection before closing", () => {
      const onClose = vi.fn();
      render(<ActivityView {...props({ groups: queue(), onClose })} />);

      expect(selectedThreadId()).toBe("first");
      fireEvent.keyDown(window, { key: "Escape" });
      expect(selectedThreadId()).toBeUndefined();
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.keyDown(window, { key: "Escape" });
      expect(onClose).toHaveBeenCalledOnce();
    });

    it("hands focus back to the main app instead of closing a detached window", () => {
      const onReturnFocus = vi.fn();
      const onClose = vi.fn();
      render(
        <ActivityView
          {...props({ groups: queue(), onClose, onReturnFocus })}
          onClose={undefined}
        />,
      );

      fireEvent.keyDown(window, { key: "Escape" });
      expect(onReturnFocus).not.toHaveBeenCalled();
      fireEvent.keyDown(window, { key: "Escape" });
      expect(onReturnFocus).toHaveBeenCalledOnce();
      expect(onClose).not.toHaveBeenCalled();
    });

    it("shows the shortcut list on ? and dismisses it on Escape", () => {
      render(<ActivityView {...props({ groups: queue() })} />);

      fireEvent.keyDown(window, { key: "?" });
      expect(
        screen.getByRole("dialog", { name: "Keyboard shortcuts" }),
      ).toBeInTheDocument();

      fireEvent.keyDown(window, { key: "Escape" });
      expect(
        screen.queryByRole("dialog", { name: "Keyboard shortcuts" }),
      ).not.toBeInTheDocument();
    });

    it("says which window the keyboard is talking to", () => {
      const { rerender } = render(
        <ActivityView {...props({ groups: queue() })} windowFocused />,
      );
      expect(screen.getByText("Keyboard ready")).toBeInTheDocument();

      rerender(
        <ActivityView {...props({ groups: queue() })} windowFocused={false} />,
      );
      expect(screen.getByText("Click to focus")).toBeInTheDocument();
    });
  });

  describe("recent trail", () => {
    const finished = (count = 1) =>
      groups([
        ...Array.from({ length: count }, (_, index) =>
          thread({
            id: index === 0 ? "finished" : `finished-${index + 1}`,
            updated_at: new Date(
              Date.now() - 120_000 - index * 60_000,
            ).toISOString(),
            attention: {
              ...thread({ id: "base" }).attention,
              last_agent_activity_seq: 3,
              last_read_seq: 3,
            },
          }),
        ),
      ]);

    it("shows recent finished threads by default and opens one", () => {
      const onOpenThread = vi.fn();
      render(<ActivityView {...props({ groups: finished(), onOpenThread })} />);

      fireEvent.click(screen.getByRole("button", { name: /finished/ }));
      expect(onOpenThread).toHaveBeenCalledWith(workspace.id, "finished");
    });

    it("shows a truncated last-agent preview with the full text on hover", () => {
      const preview = "Implemented the fix and verified the complete desktop suite.";
      const recent = finished();
      recent[0]!.threads[0]!.last_message_preview = preview;
      render(<ActivityView {...props({ groups: recent })} />);

      expect(screen.getByText(preview)).toHaveClass("truncate");
      expect(screen.getByText(preview)).toHaveAttribute("title", preview);
    });

    it("selects and opens a recent thread from the keyboard", () => {
      const onOpenThread = vi.fn();
      render(<ActivityView {...props({ groups: finished(), onOpenThread })} />);

      expect(
        document.querySelector(
          '[data-activity-key="recent:workspace-1:finished"]',
        ),
      ).toHaveAttribute("data-selected", "true");
      fireEvent.keyDown(window, { key: "Enter" });
      expect(onOpenThread).toHaveBeenCalledWith(workspace.id, "finished");
    });

    it("shows five recent threads before expanding the rest", () => {
      render(<ActivityView {...props({ groups: finished(7) })} />);

      expect(screen.getByText("finished-5")).toBeInTheDocument();
      expect(screen.queryByText("finished-6")).not.toBeInTheDocument();
      const showMore = screen.getByRole("button", { name: "Show 2 more" });
      expect(showMore).toHaveAttribute("aria-expanded", "false");

      fireEvent.click(showMore);
      expect(screen.getByText("finished-7")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Show fewer" }),
      ).toHaveAttribute("aria-expanded", "true");
    });

    it("navigates down to the recent toggle and activates it with Enter", () => {
      render(<ActivityView {...props({ groups: finished(7) })} />);

      for (const [index, element] of Array.from(
        document.querySelectorAll<HTMLElement>("[data-activity-key]"),
      ).entries()) {
        const top = index * 100;
        element.getBoundingClientRect = vi.fn(() => ({
          left: 0,
          top,
          width: 800,
          height: 60,
          right: 800,
          bottom: top + 60,
          x: 0,
          y: top,
          toJSON: () => ({}),
        }));
      }

      for (let index = 0; index < 5; index += 1) {
        fireEvent.keyDown(window, { key: "ArrowDown" });
      }
      const showMore = screen.getByRole("button", { name: "Show 2 more" });
      expect(showMore).toHaveAttribute("data-selected", "true");

      fireEvent.keyDown(window, { key: "Enter" });
      expect(screen.getByText("finished-7")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Show fewer" }),
      ).toHaveAttribute("data-selected", "true");
    });

    it("expands recent threads with T and opens the newly revealed rows", () => {
      const onOpenThread = vi.fn();
      render(
        <ActivityView {...props({ groups: finished(7), onOpenThread })} />,
      );

      fireEvent.keyDown(window, { key: "t" });
      expect(screen.getByText("finished-6")).toBeInTheDocument();
      for (let index = 0; index < 5; index += 1) {
        fireEvent.keyDown(window, { key: "j" });
      }
      fireEvent.keyDown(window, { key: "Enter" });
      expect(onOpenThread).toHaveBeenCalledWith(workspace.id, "finished-6");
    });

    it("never lists a thread that is still in the queue", () => {
      render(
        <ActivityView
          {...props({
            groups: groups([
              thread({
                id: "still-running",
                status: "running",
                attention: {
                  ...thread({ id: "base" }).attention,
                  level: "running",
                  last_agent_activity_seq: 3,
                },
              }),
            ]),
          })}
        />,
      );

      expect(
        screen.queryByRole("button", { name: /Recent/ }),
      ).not.toBeInTheDocument();
    });
  });
});

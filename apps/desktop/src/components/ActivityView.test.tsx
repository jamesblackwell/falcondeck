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
  ThreadDetail,
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
  vi.restoreAllMocks();
});

describe("ActivityView", () => {
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
      screen.getByRole("heading", { name: "Needs a response" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Failed" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Working" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Completed" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Ready" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Running" }),
    ).not.toBeInTheDocument();
    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual([
      "Needs a response",
      "Failed",
      "Working",
      "Completed",
    ]);
    expect(screen.getByText("ready")).toHaveClass("font-semibold");
    expect(screen.getByText("Process exited 1")).toBeInTheDocument();
    expect(screen.getByText("Implementation complete")).toBeInTheDocument();
    expect(screen.getByText("Running tests")).toBeInTheDocument();
    expect(screen.getByLabelText("Activity summary")).toHaveTextContent(
      "3 need attention",
    );
    expect(
      document.querySelector('[data-activity-list="running"]'),
    ).toBeInTheDocument();
    expect(
      document.querySelector('[data-activity-thread="running"]'),
    ).not.toHaveClass("h-64");
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
      screen.queryByRole("heading", { name: "Working" }),
    ).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1_500));
    expect(screen.queryByText("Resolved")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Working" }),
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
    const { rerender } = render(<ActivityView {...props({ onPopOut })} />);

    fireEvent.click(screen.getByRole("button", { name: "Open in new window" }));
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

  it("shows the caught-up state and optional new-task affordance", () => {
    const onNewThread = vi.fn();
    render(<ActivityView {...props({ onNewThread })} />);
    expect(screen.getByText("All caught up")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(onNewThread).toHaveBeenCalledOnce();
  });

  describe("preview", () => {
    function detail(): ThreadDetail {
      return {
        workspace,
        thread: thread({
          id: "first",
          attention: {
            ...thread({ id: "base" }).attention,
            last_agent_activity_seq: 7,
          },
        }),
        items: [
          {
            id: "reply",
            kind: "assistant_message",
            text: "Latest reply to review",
            created_at: new Date().toISOString(),
          },
        ],
        has_older: true,
        oldest_item_id: "reply",
        newest_item_id: "reply",
        is_partial: false,
      } as ThreadDetail;
    }

    it("selects on click, previews on Enter, marks only loaded messages read, and returns with Escape", async () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      const onLoadPreview = vi.fn().mockResolvedValue(detail());
      const onOpenThread = vi.fn();
      const onMarkThreadRead = vi.fn();
      const onClose = vi.fn();
      render(
        <ActivityView
          {...props({
            groups: queue(),
            onLoadPreview,
            onSendPreview: vi.fn(),
            onOpenThread,
            onMarkThreadRead,
            onClose,
          })}
        />,
      );
      const row = screen.getByRole("button", { name: /first/ });
      fireEvent.click(row);
      expect(selectedThreadId()).toBe("first");
      expect(onLoadPreview).not.toHaveBeenCalled();
      fireEvent.keyDown(row, { key: "Enter" });
      expect(
        await screen.findByText("Latest reply to review"),
      ).toBeInTheDocument();
      expect(onMarkThreadRead).toHaveBeenCalledWith(workspace.id, "first", 7);
      fireEvent.change(screen.getByRole("textbox", { name: "Quick reply" }), {
        target: { value: "Unsent follow-up" },
      });
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Quick reply" }), {
        key: "Escape",
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
      expect(onOpenThread).not.toHaveBeenCalled();
      await act(async () => {
        fireEvent.keyDown(window, { key: "Enter" });
      });
      expect(screen.getByRole("textbox", { name: "Quick reply" })).toHaveValue(
        "Unsent follow-up",
      );
    });

    it("keeps failed replies and preserves newer draft text while a send is pending", async () => {
      let resolveSend!: () => void;
      const onSendPreview = vi
        .fn()
        .mockRejectedValueOnce(new Error("Host unavailable"))
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              resolveSend = resolve;
            }),
        );
      const onOpenThread = vi.fn();
      render(
        <ActivityView
          {...props({
            groups: queue(),
            onLoadPreview: vi.fn().mockResolvedValue(detail()),
            onSendPreview,
            onOpenThread,
          })}
        />,
      );
      fireEvent.keyDown(window, { key: "Enter" });
      await screen.findByText("Latest reply to review");
      const reply = screen.getByRole("textbox", { name: "Quick reply" });
      fireEvent.change(reply, { target: { value: "Follow-up" } });
      fireEvent.keyDown(reply, { key: "Enter" });
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Host unavailable",
      );
      expect(reply).toHaveValue("Follow-up");
      fireEvent.keyDown(reply, { key: "Enter" });
      fireEvent.change(reply, { target: { value: "Next thought" } });
      await act(async () => resolveSend());
      expect(reply).toHaveValue("Next thought");
      expect(onSendPreview).toHaveBeenCalledWith(
        workspace.id,
        "first",
        "Follow-up",
      );
      expect(onOpenThread).not.toHaveBeenCalled();
    });

    it("does not mark a failed or partial load read and discards a load after closing", async () => {
      vi.spyOn(document, "hasFocus").mockReturnValue(true);
      let resolveLoad!: (value: ThreadDetail) => void;
      const onLoadPreview = vi
        .fn()
        .mockRejectedValueOnce(new Error("Cannot load messages"))
        .mockResolvedValueOnce({ ...detail(), is_partial: true })
        .mockImplementationOnce(
          () =>
            new Promise<ThreadDetail>((resolve) => {
              resolveLoad = resolve;
            }),
        );
      const onMarkThreadRead = vi.fn();
      render(
        <ActivityView
          {...props({
            groups: queue(),
            onLoadPreview,
            onSendPreview: vi.fn(),
            onMarkThreadRead,
          })}
        />,
      );
      fireEvent.keyDown(window, { key: "Enter" });
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Cannot load messages",
      );
      fireEvent.click(screen.getByRole("button", { name: "Refresh messages" }));
      await screen.findByText("Latest reply to review");
      expect(onMarkThreadRead).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Refresh messages" }));
      fireEvent.keyDown(window, { key: "Escape" });
      await act(async () => resolveLoad(detail()));
      expect(onMarkThreadRead).not.toHaveBeenCalled();
    });
  });

  describe("keyboard", () => {
    it("moves through the queue with j/k and opens with Enter", () => {
      const onOpenThread = vi.fn();
      render(<ActivityView {...props({ groups: queue(), onOpenThread })} />);

      fireEvent.keyDown(window, { key: "j" });
      expect(selectedThreadId()).toBe("first");
      fireEvent.keyDown(window, { key: "j" });
      expect(selectedThreadId()).toBe("second");
      fireEvent.keyDown(window, { key: "k" });
      expect(selectedThreadId()).toBe("first");

      fireEvent.keyDown(window, { key: "Enter" });
      expect(onOpenThread).toHaveBeenCalledWith(workspace.id, "first");
    });

    it("moves through the inbox with the arrow keys", () => {
      const running = ["a", "b", "c"].map((id) =>
        thread({
          id,
          status: "running",
          updated_at: "2026-08-13T12:00:00Z",
          attention: {
            ...thread({ id: "base" }).attention,
            level: "running",
          },
        }),
      );
      render(<ActivityView {...props({ groups: groups(running) })} />);
      expect(screen.getByText("3 working")).toBeInTheDocument();

      fireEvent.keyDown(window, { key: "ArrowDown" });
      expect(selectedThreadId()).toBe("a");
      fireEvent.keyDown(window, { key: "ArrowDown" });
      expect(selectedThreadId()).toBe("b");
      fireEvent.keyDown(window, { key: "ArrowUp" });
      expect(selectedThreadId()).toBe("a");
    });

    it("clears the selected thread with R", () => {
      const onMarkThreadRead = vi.fn();
      render(
        <ActivityView {...props({ groups: queue(), onMarkThreadRead })} />,
      );

      fireEvent.keyDown(window, { key: "j" });
      fireEvent.keyDown(window, { key: "r" });
      expect(onMarkThreadRead).toHaveBeenCalledWith(workspace.id, "first");
    });

    it("leaves the keys alone while the user is typing or holding a modifier", () => {
      const onOpenThread = vi.fn();
      render(<ActivityView {...props({ groups: queue(), onOpenThread })} />);

      const input = document.createElement("input");
      document.body.appendChild(input);
      fireEvent.keyDown(input, { key: "j" });
      expect(selectedThreadId()).toBeUndefined();
      input.remove();

      fireEvent.keyDown(window, { key: "j", metaKey: true });
      expect(selectedThreadId()).toBeUndefined();
    });

    it("steps Escape back through selection before closing", () => {
      const onClose = vi.fn();
      render(<ActivityView {...props({ groups: queue(), onClose })} />);

      fireEvent.keyDown(window, { key: "j" });
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

      fireEvent.keyDown(window, { key: "j" });
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
      expect(screen.getByText("2 need attention")).toBeInTheDocument();

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
      const preview =
        "Implemented the fix and verified the complete desktop suite.";
      const recent = finished();
      recent[0]!.threads[0]!.last_message_preview = preview;
      render(<ActivityView {...props({ groups: recent })} />);

      expect(screen.getByText(preview)).toHaveClass("truncate");
      expect(screen.getByText(preview)).toHaveAttribute("title", preview);
    });

    it("selects and opens a recent thread from the keyboard", () => {
      const onOpenThread = vi.fn();
      render(<ActivityView {...props({ groups: finished(), onOpenThread })} />);

      fireEvent.keyDown(window, { key: "j" });
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

      for (let index = 0; index < 6; index += 1) {
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
      for (let index = 0; index < 6; index += 1) {
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
        screen.queryByRole("heading", { name: "Completed" }),
      ).not.toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Working" }),
      ).toBeInTheDocument();
    });

    it("lists the task that just moved at the top of Working", () => {
      render(
        <ActivityView
          {...props({
            groups: groups([
              thread({
                id: "alpha",
                title: "Alpha",
                status: "running",
                updated_at: "2026-08-13T08:00:00Z",
                attention: {
                  ...thread({ id: "base" }).attention,
                  level: "running",
                },
              }),
              thread({
                id: "zebra",
                title: "Zebra",
                status: "running",
                updated_at: "2026-08-13T10:00:00Z",
                attention: {
                  ...thread({ id: "base" }).attention,
                  level: "running",
                },
              }),
            ]),
          })}
        />,
      );

      const alpha = document.querySelector('[data-activity-thread="alpha"]')!;
      const zebra = document.querySelector('[data-activity-thread="zebra"]')!;
      expect(zebra.compareDocumentPosition(alpha)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });

    it("keeps a task marked read in place until the pointer leaves", () => {
      const updatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
      const unread = thread({
        id: "older",
        title: "Older",
        updated_at: updatedAt,
        attention: {
          ...thread({ id: "base" }).attention,
          level: "unread",
          unread: true,
          last_agent_activity_seq: 4,
        },
      });
      const newer = thread({
        id: "newer",
        title: "Newer",
        updated_at: new Date(Date.now() - 60_000).toISOString(),
        attention: {
          ...thread({ id: "base" }).attention,
          last_agent_activity_seq: 4,
          last_read_seq: 4,
        },
      });
      const read = thread({
        id: "older",
        title: "Older",
        updated_at: updatedAt,
        attention: {
          ...thread({ id: "base" }).attention,
          last_agent_activity_seq: 4,
          last_read_seq: 4,
        },
      });
      const completedIds = () =>
        [
          ...document.querySelectorAll(
            '[data-activity-list="completed"] [data-activity-thread]',
          ),
        ].map((row) => row.getAttribute("data-activity-thread"));

      const { rerender } = render(
        <ActivityView {...props({ groups: groups([unread, newer]) })} />,
      );
      expect(completedIds()).toEqual(["older", "newer"]);
      expect(screen.getByText("Older")).toHaveClass("font-semibold");

      fireEvent.pointerEnter(document.querySelector("[data-activity-root]")!);
      rerender(<ActivityView {...props({ groups: groups([read, newer]) })} />);

      expect(completedIds()).toEqual(["older", "newer"]);
      expect(screen.getByText("Older")).not.toHaveClass("font-semibold");
      expect(
        document.querySelector('[data-activity-thread="older"] .bg-unread'),
      ).toBeNull();
      expect(
        screen.queryByRole("button", { name: "Mark read" }),
      ).not.toBeInTheDocument();

      fireEvent.pointerLeave(document.querySelector("[data-activity-root]")!);
      expect(completedIds()).toEqual(["newer", "older"]);
    });

    it("keeps the selection on a finish after it is marked read", () => {
      const updatedAt = new Date(Date.now() - 10 * 60_000).toISOString();
      const unread = thread({
        id: "older",
        title: "Older",
        updated_at: updatedAt,
        attention: {
          ...thread({ id: "base" }).attention,
          level: "unread",
          unread: true,
          last_agent_activity_seq: 4,
        },
      });
      const newer = thread({
        id: "newer",
        title: "Newer",
        updated_at: new Date(Date.now() - 60_000).toISOString(),
        attention: {
          ...thread({ id: "base" }).attention,
          last_agent_activity_seq: 4,
          last_read_seq: 4,
        },
      });
      const read = thread({
        id: "older",
        title: "Older",
        updated_at: updatedAt,
        attention: {
          ...thread({ id: "base" }).attention,
          last_agent_activity_seq: 4,
          last_read_seq: 4,
        },
      });
      const { rerender } = render(
        <ActivityView {...props({ groups: groups([unread, newer]) })} />,
      );

      fireEvent.keyDown(window, { key: "j" });
      expect(
        document.querySelector(
          '[data-activity-key="workspace-1:older"]',
        ),
      ).toHaveAttribute("data-selected", "true");

      fireEvent.pointerEnter(document.querySelector("[data-activity-root]")!);
      rerender(<ActivityView {...props({ groups: groups([read, newer]) })} />);

      expect(
        document.querySelector('[data-activity-key="workspace-1:older"]'),
      ).toBeNull();
      expect(
        document.querySelector(
          '[data-activity-key="recent:workspace-1:older"]',
        ),
      ).toHaveAttribute("data-selected", "true");
      expect(document.querySelectorAll("[data-selected='true']")).toHaveLength(
        1,
      );

      fireEvent.keyDown(window, { key: "j" });
      expect(selectedThreadId()).toBe("newer");
    });

    it("shows an acknowledged failure in Completed while the pointer is over the list", () => {
      const failed = thread({
        id: "broken",
        title: "Broken",
        updated_at: new Date().toISOString(),
        last_error: "Process exited 1",
        attention: {
          ...thread({ id: "base" }).attention,
          level: "error",
          unread: true,
          last_agent_activity_seq: 5,
        },
      });
      const settled = thread({
        id: "settled",
        title: "Settled",
        updated_at: new Date(Date.now() - 2 * 60_000).toISOString(),
        attention: {
          ...thread({ id: "base" }).attention,
          last_agent_activity_seq: 3,
          last_read_seq: 3,
        },
      });
      const read = thread({
        id: "broken",
        title: "Broken",
        updated_at: failed.updated_at,
        last_error: "Process exited 1",
        attention: {
          ...failed.attention,
          unread: false,
          last_read_seq: 5,
        },
      });
      const completedIds = () =>
        [
          ...document.querySelectorAll(
            '[data-activity-list="completed"] [data-activity-thread]',
          ),
        ].map((row) => row.getAttribute("data-activity-thread"));

      const { rerender } = render(
        <ActivityView {...props({ groups: groups([failed, settled]) })} />,
      );
      expect(
        screen.getByRole("heading", { name: "Failed" }),
      ).toBeInTheDocument();
      expect(completedIds()).toEqual(["settled"]);

      fireEvent.pointerEnter(document.querySelector("[data-activity-root]")!);
      rerender(<ActivityView {...props({ groups: groups([read, settled]) })} />);

      expect(
        screen.queryByRole("heading", { name: "Failed" }),
      ).not.toBeInTheDocument();
      expect(completedIds()).toEqual(["broken", "settled"]);
      expect(screen.getByText("Broken")).toBeInTheDocument();
    });

    it("shows a new finish while a row marked read stays put", () => {
      const olderAt = new Date(Date.now() - 10 * 60_000).toISOString();
      const unread = thread({
        id: "older",
        title: "Older",
        updated_at: olderAt,
        attention: {
          ...thread({ id: "base" }).attention,
          level: "unread",
          unread: true,
          last_agent_activity_seq: 4,
        },
      });
      const newer = thread({
        id: "newer",
        title: "Newer",
        updated_at: new Date(Date.now() - 60_000).toISOString(),
        attention: {
          ...thread({ id: "base" }).attention,
          last_agent_activity_seq: 4,
          last_read_seq: 4,
        },
      });
      const read = thread({
        id: "older",
        title: "Older",
        updated_at: olderAt,
        attention: {
          ...unread.attention,
          level: "none",
          unread: false,
          last_read_seq: 4,
        },
      });
      const fresh = thread({
        id: "fresh",
        title: "Fresh",
        updated_at: new Date().toISOString(),
        last_message_preview: "Just finished",
        attention: {
          ...thread({ id: "base" }).attention,
          level: "unread",
          unread: true,
          last_agent_activity_seq: 6,
        },
      });
      const completedIds = () =>
        [
          ...document.querySelectorAll(
            '[data-activity-list="completed"] [data-activity-thread]',
          ),
        ].map((row) => row.getAttribute("data-activity-thread"));

      const { rerender } = render(
        <ActivityView {...props({ groups: groups([unread, newer]) })} />,
      );
      expect(completedIds()).toEqual(["older", "newer"]);

      fireEvent.pointerEnter(document.querySelector("[data-activity-root]")!);
      rerender(
        <ActivityView {...props({ groups: groups([read, newer, fresh]) })} />,
      );

      expect(completedIds()).toEqual(["older", "fresh", "newer"]);
      expect(screen.getByText("Fresh")).toHaveClass("font-semibold");
      expect(screen.getByText("Older")).not.toHaveClass("font-semibold");
      expect(screen.getByText("Just finished")).toBeInTheDocument();
    });

    it("does not list a thread twice while its resolved request is still on screen", async () => {
      vi.useFakeTimers();
      const blocked = thread({
        id: "blocked",
        attention: {
          ...thread({ id: "base" }).attention,
          last_agent_activity_seq: 4,
          last_read_seq: 4,
        },
      });
      const initial = props({
        groups: groups([blocked]),
        interactiveRequests: [request("blocked")],
      });
      const { rerender } = render(<ActivityView {...initial} />);

      fireEvent.click(screen.getByRole("button", { name: "Allow" }));
      await act(async () => {});
      rerender(<ActivityView {...initial} interactiveRequests={[]} />);

      expect(screen.getByText("Resolved")).toBeInTheDocument();
      expect(
        document.querySelectorAll('[data-activity-thread="blocked"]'),
      ).toHaveLength(1);
      expect(
        screen.queryByRole("heading", { name: "Completed" }),
      ).not.toBeInTheDocument();

      act(() => vi.advanceTimersByTime(1_500));
      expect(screen.queryByText("Resolved")).not.toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Completed" }),
      ).toBeInTheDocument();
      expect(
        document.querySelectorAll('[data-activity-thread="blocked"]'),
      ).toHaveLength(1);
    });
  });
});

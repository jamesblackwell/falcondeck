import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  ProjectGroup,
  ThreadSummary,
  WorkspaceSummary,
} from "@falcondeck/client-core";

import { ActivityWindow } from "./ActivityWindow";
import {
  ACTIVITY_WINDOW_EVENTS,
  type ActivityWindowState,
} from "./activity-window-bridge";

type Handler = (event: { payload: unknown }) => void;

const listeners = new Map<string, Set<Handler>>();
const emitted: { event: string; payload: unknown }[] = [];
const invoked: string[] = [];
const onCloseRequested = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload?: unknown) => {
    emitted.push({ event, payload });
    return Promise.resolve();
  },
  listen: (event: string, handler: Handler) => {
    const handlers = listeners.get(event) ?? new Set<Handler>();
    handlers.add(handler);
    listeners.set(event, handlers);
    return Promise.resolve(() => handlers.delete(handler));
  },
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (command: string) => {
    invoked.push(command);
    return Promise.resolve();
  },
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: (handler: () => void) => {
      onCloseRequested(handler);
      return Promise.resolve(() => {});
    },
  }),
}));

function deliver(event: string, payload: unknown) {
  act(() => {
    for (const handler of listeners.get(event) ?? []) handler({ payload });
  });
}

function state(): ActivityWindowState {
  const workspace = {
    id: "ws-1",
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
  } as unknown as WorkspaceSummary;

  const thread = {
    id: "thread-1",
    workspace_id: "ws-1",
    title: "Migrate billing webhooks",
    provider: "codex",
    status: "idle",
    updated_at: "2026-08-13T09:00:00Z",
    last_message_preview: "Implementation complete",
    latest_turn_id: null,
    latest_plan: null,
    latest_diff: null,
    last_tool: null,
    last_error: null,
    agent: {},
    attention: {
      level: "unread",
      badge_label: null,
      unread: true,
      pending_approval_count: 0,
      pending_question_count: 0,
      last_agent_activity_seq: 2,
      last_read_seq: 1,
    },
    is_archived: false,
    is_pinned: false,
    goal: null,
    queued_turns: [],
    variant: null,
  } as unknown as ThreadSummary;

  const groups: ProjectGroup[] = [{ workspace, threads: [thread] }];
  return {
    groups,
    interactiveRequests: [],
    workspaceHosts: {},
    canStartThread: true,
  };
}

beforeEach(() => {
  listeners.clear();
  emitted.length = 0;
  invoked.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ActivityWindow", () => {
  it("asks the main window for state and renders what it sends", async () => {
    render(<ActivityWindow />);

    expect(screen.getByText("Waiting for FalconDeck")).toBeInTheDocument();
    await waitFor(() =>
      expect(emitted.map((entry) => entry.event)).toContain(
        ACTIVITY_WINDOW_EVENTS.ready,
      ),
    );

    deliver(ACTIVITY_WINDOW_EVENTS.state, state());
    expect(
      await screen.findByText("Migrate billing webhooks"),
    ).toBeInTheDocument();
    expect(screen.getByText("Implementation complete")).toBeInTheDocument();
  });

  it("hands a thread to the main window and raises it, staying open itself", async () => {
    render(<ActivityWindow />);
    await waitFor(() => expect(listeners.size).toBeGreaterThan(0));
    deliver(ACTIVITY_WINDOW_EVENTS.state, state());

    fireEvent.click(
      await screen.findByRole("button", { name: /Migrate billing webhooks/ }),
    );

    expect(
      emitted.find((entry) => entry.event === ACTIVITY_WINDOW_EVENTS.openThread)
        ?.payload,
    ).toEqual({ workspaceId: "ws-1", threadId: "thread-1" });
    await waitFor(() => expect(invoked).toContain("focus_main_window"));
    // The whole point of detaching: the queue is still on screen.
    expect(screen.getByText("Migrate billing webhooks")).toBeInTheDocument();
  });

  it("marks a thread read through the main window", async () => {
    render(<ActivityWindow />);
    await waitFor(() => expect(listeners.size).toBeGreaterThan(0));
    deliver(ACTIVITY_WINDOW_EVENTS.state, state());

    fireEvent.click(await screen.findByRole("button", { name: "Mark read" }));

    expect(
      emitted.find((entry) => entry.event === ACTIVITY_WINDOW_EVENTS.markRead)
        ?.payload,
    ).toEqual({ workspaceId: "ws-1", threadId: "thread-1" });
  });

  it("round-trips an approval and reports the main window's failure on the card", async () => {
    const blocked = state();
    blocked.interactiveRequests = [
      {
        request_id: "req-1",
        workspace_id: "ws-1",
        thread_id: "thread-1",
        method: "command",
        kind: "approval",
        approval_decisions: ["allow", "deny"],
        title: "Run tests?",
        detail: null,
        command: "npm test",
        path: "/projects/falcon",
        turn_id: null,
        item_id: null,
        questions: [],
        created_at: "2026-08-13T09:00:00Z",
      },
    ] as ActivityWindowState["interactiveRequests"];

    render(<ActivityWindow />);
    await waitFor(() => expect(listeners.size).toBeGreaterThan(0));
    deliver(ACTIVITY_WINDOW_EVENTS.state, blocked);

    fireEvent.click(await screen.findByRole("button", { name: "Allow" }));

    const respond = await waitFor(() => {
      const sent = emitted.find(
        (entry) => entry.event === ACTIVITY_WINDOW_EVENTS.respond,
      );
      expect(sent).toBeDefined();
      return sent!.payload as { callId: string; response: unknown };
    });
    expect(respond.response).toEqual({ kind: "approval", decision: "allow" });

    // A result for someone else's call must not settle this one.
    deliver(ACTIVITY_WINDOW_EVENTS.respondResult, {
      callId: "someone-else",
      error: "not mine",
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    deliver(ACTIVITY_WINDOW_EVENTS.respondResult, {
      callId: respond.callId,
      error: "Host rejected the response",
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Host rejected the response",
    );
  });

  it("tells the main window to stop pushing when it closes", async () => {
    render(<ActivityWindow />);
    await waitFor(() => expect(onCloseRequested).toHaveBeenCalled());

    act(() => onCloseRequested.mock.calls.at(-1)![0]());
    expect(emitted.map((entry) => entry.event)).toContain(
      ACTIVITY_WINDOW_EVENTS.closed,
    );
  });
});

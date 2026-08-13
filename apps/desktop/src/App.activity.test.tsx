import React, { useState } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const testSnapshot = vi.hoisted(() => ({
  daemon: {
    version: "0.1.0",
    started_at: "2026-08-13T08:00:00Z",
    capabilities: {},
  },
  workspaces: [
    {
      id: "workspace-1",
      path: "/projects/falcon",
      status: "ready",
      agents: [],
      default_provider: "codex",
      models: [],
      collaboration_modes: [],
      account: { status: "ready", label: "Ready" },
      current_thread_id: "thread-1",
      connected_at: "2026-08-13T08:00:00Z",
      updated_at: "2026-08-13T08:00:00Z",
      last_error: null,
    },
  ],
  threads: [
    {
      id: "thread-1",
      workspace_id: "workspace-1",
      title: "Needs a decision",
      provider: "codex",
      status: "waiting_for_input",
      updated_at: "2026-08-13T09:00:00Z",
      last_message_preview: null,
      latest_turn_id: null,
      latest_plan: null,
      latest_diff: null,
      last_tool: null,
      last_error: null,
      agent: {},
      attention: {
        level: "awaiting_response",
        badge_label: "Awaiting response",
        unread: true,
        pending_approval_count: 1,
        pending_question_count: 0,
        last_agent_activity_seq: 2,
        last_read_seq: 1,
      },
      is_archived: false,
      is_pinned: false,
      goal: null,
      queued_turns: [],
      variant: null,
    },
  ],
  interactive_requests: [
    {
      request_id: "request-1",
      workspace_id: "workspace-1",
      thread_id: "thread-1",
      method: "command",
      kind: "approval",
      approval_decisions: ["allow", "deny"],
      title: "Run command?",
      detail: null,
      command: "npm test",
      path: "/projects/falcon",
      turn_id: null,
      item_id: null,
      questions: [],
      created_at: "2026-08-13T09:00:00Z",
    },
  ],
  preferences: {
    workspace_order: [],
    notifications: {
      enabled: false,
      notify_on_input_required: true,
      notify_on_error: true,
      notify_on_turn_complete: true,
    },
  },
  extensions: {
    catalog: [
      {
        id: "falcondeck.mini-zen",
        name: "Mini Zen",
        version: "0.1.0",
        source: "bundled",
        bundled: true,
        enabled: true,
        status: "active",
        contributes: {
          threadMenuActions: [],
          threadDecorations: [],
          sidebarFilters: [],
          panels: [
            {
              id: "attention",
              title: "Mini Zen",
              view: "attention-panel",
              ui: {
                version: 1,
                root: { type: "text", text: "One thing at a time" },
              },
            },
          ],
        },
        permissions: [],
      },
    ],
    views: [],
  },
  scheduled_tasks: [],
}));

vi.mock("./hooks/useDaemonConnection", () => ({
  useDaemonConnection: () => {
    const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<
      string | null
    >("workspace-1");
    const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
      "thread-1",
    );
    const [snapshot, setSnapshot] = useState(testSnapshot);
    const [threadDetail, setThreadDetail] = useState(null);
    return {
      api: null,
      baseUrl: "http://127.0.0.1:8787",
      connectionError: null,
      snapshot,
      setSnapshot,
      threadDetail,
      setThreadDetail,
      threadDetailError: null,
      retryThreadDetail: vi.fn(),
      remoteStatus: null,
      setRemoteStatus: vi.fn(),
      selectedWorkspaceId,
      setSelectedWorkspaceId,
      selectedThreadId,
      setSelectedThreadId,
      gitRefreshTrigger: 0,
    };
  },
}));

vi.mock("./hooks/useRemoteHosts", () => ({
  useRemoteHosts: () => ({
    hosts: [],
    hostForWorkspace: () => null,
    manager: { connection: () => null },
  }),
}));

vi.mock("./hooks/usePanelVisibility", () => ({
  usePanelVisibility: () => ({
    sidebarVisible: true,
    railVisible: true,
    toggleSidebar: vi.fn(),
    toggleRail: vi.fn(),
    showRail: vi.fn(),
    hideSidebar: vi.fn(),
    hideRail: vi.fn(),
  }),
}));

vi.mock("./hooks/useGitBranches", () => ({
  useGitBranches: () => ({
    branches: [],
    uncommittedCount: 0,
    isCheckoutPending: false,
    checkout: vi.fn(),
  }),
}));

vi.mock("./hooks/useAppUpdater", () => ({
  useAppUpdater: () => ({
    state: { status: "idle", availableVersion: null },
    progressPercent: null,
    checkForUpdates: vi.fn(),
    downloadAndInstall: vi.fn(),
    restartToInstall: vi.fn(),
  }),
}));

vi.mock("./components/DesktopShell", () => ({
  DesktopShell: ({
    sidebar,
    main,
    rail,
  }: {
    sidebar: React.ReactNode;
    main: React.ReactNode;
    rail?: React.ReactNode;
  }) => (
    <div>
      <aside>{sidebar}</aside>
      <main>{main}</main>
      {rail ? <div data-testid="rail">{rail}</div> : null}
    </div>
  ),
}));

vi.mock("./components/DesktopConversationPane", () => ({
  DesktopConversationPane: () => <div>Conversation pane</div>,
}));

vi.mock("./components/DiffPanel", () => ({
  DiffPanel: () => <div>Diff rail</div>,
}));

import App from "./App";

describe("Activity takeover wiring", () => {
  it("suppresses the rail and closes the takeover when a thread is selected", async () => {
    render(<App />);
    expect(await screen.findByText("Diff rail")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(
      await screen.findByRole("heading", { name: "Activity" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Diff rail")).not.toBeInTheDocument();

    fireEvent.click(
      within(screen.getByRole("main")).getByRole("button", {
        name: /Needs a decision/,
      }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("heading", { name: "Activity" }),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByText("Conversation pane")).toBeInTheDocument();
    expect(await screen.findByText("Diff rail")).toBeInTheDocument();
  });

  it("opens declarative extension panels through the main-view registry", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Mini Zen" }));

    expect(await screen.findByText("One thing at a time")).toBeInTheDocument();
    expect(screen.queryByText("Conversation pane")).not.toBeInTheDocument();
    expect(screen.queryByText("Diff rail")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close Mini Zen" }));
    expect(await screen.findByText("Conversation pane")).toBeInTheDocument();
    expect(await screen.findByText("Diff rail")).toBeInTheDocument();
  });
});

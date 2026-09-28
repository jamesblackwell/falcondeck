import React, { useState } from "react";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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
      is_pinned_in_project: false,
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
const testApi = vi.hoisted(() => ({
  current: null as null | {
    createChat: ReturnType<typeof vi.fn>;
    snapshot: ReturnType<typeof vi.fn>;
    setClientActivity: ReturnType<typeof vi.fn>;
    markThreadRead: ReturnType<typeof vi.fn>;
  },
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
      api: testApi.current,
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
    sidebarVisible,
  }: {
    sidebar: React.ReactNode;
    main: React.ReactNode;
    rail?: React.ReactNode;
    sidebarVisible?: boolean;
  }) => (
    <div>
      <aside data-testid="sidebar" data-visible={String(sidebarVisible)}>
        {sidebar}
      </aside>
      <main>{main}</main>
      {rail ? <div data-testid="rail">{rail}</div> : null}
    </div>
  ),
}));

vi.mock("./components/DesktopConversationPane", () => ({
  DesktopConversationPane: ({
    promptInputProps,
    selectedWorkspace,
  }: {
    promptInputProps?: { value?: string; focusRequestKey?: number };
    selectedWorkspace?: { kind?: string } | null;
  }) => (
    <div>
      Conversation pane
      <span data-testid="composer-draft">{promptInputProps?.value}</span>
      <span data-testid="workspace-kind">{selectedWorkspace?.kind}</span>
      <span data-testid="composer-focus-key">
        {promptInputProps?.focusRequestKey}
      </span>
    </div>
  ),
}));

vi.mock("./components/DiffPanel", () => ({
  DiffPanel: () => <div>Diff rail</div>,
}));

import App from "./App";

describe("Activity takeover wiring", () => {
  beforeEach(() => {
    window.localStorage.clear();
    testApi.current = null;
  });

  it("opens a fresh no-project chat from the Chats plus while a panel is open", async () => {
    const chatWorkspace = {
      ...testSnapshot.workspaces[0],
      id: "chat-workspace",
      path: "/Documents/FalconDeck/2026-09-28/chat-1",
      kind: "casual",
      current_thread_id: null,
    };
    testApi.current = {
      createChat: vi.fn().mockResolvedValue(chatWorkspace),
      snapshot: vi.fn().mockResolvedValue({
        ...testSnapshot,
        workspaces: [...testSnapshot.workspaces, chatWorkspace],
      }),
      setClientActivity: vi.fn().mockResolvedValue(undefined),
      markThreadRead: vi
        .fn()
        .mockResolvedValue({ thread: testSnapshot.threads[0] }),
    };
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Mini Zen" }));
    expect(await screen.findByText("One thing at a time")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Start new chat" }));
    await waitFor(() => {
      expect(screen.getByText("Conversation pane")).toBeInTheDocument();
      expect(screen.getByTestId("workspace-kind")).toHaveTextContent("casual");
      expect(
        Number(screen.getByTestId("composer-focus-key").textContent),
      ).toBeGreaterThan(0);
    });
    expect(testApi.current.createChat).toHaveBeenCalledOnce();
    expect(screen.queryByText("One thing at a time")).not.toBeInTheDocument();
  });

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

  it("gives settings the whole window and restores the sidebar on close", async () => {
    render(<App />);
    expect(screen.getByTestId("sidebar")).toHaveAttribute("data-visible", "true");

    fireEvent.click(screen.getByRole("button", { name: "Options" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Settings/ }));
    expect(await screen.findByText("Back to app")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar")).toHaveAttribute(
      "data-visible",
      "false",
    );

    fireEvent.click(screen.getByText("Back to app"));
    await waitFor(() => {
      expect(screen.getByTestId("sidebar")).toHaveAttribute(
        "data-visible",
        "true",
      );
    });
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

  it("opens a new thread with the scheduled-task setup prompt", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Automations" }));
    expect(
      await screen.findByRole("heading", { name: "Automations" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New automation" }));

    expect(await screen.findByText("Conversation pane")).toBeInTheDocument();
    expect(screen.getByTestId("composer-draft")).toHaveTextContent(
      "use the FalconDeck MCP server to create the automation",
    );
  });

  it("leaves Plugins when starting a new thread", async () => {
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Plugins" }));
    expect(
      await screen.findByRole("heading", { name: "Plugins" }),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Start new thread in falcon" }),
    );

    expect(await screen.findByText("Conversation pane")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Plugins" }),
    ).not.toBeInTheDocument();
  });

  it("preserves an existing new-thread draft as scheduling notes", async () => {
    window.localStorage.setItem(
      "falcondeck.desktop.composer-drafts.v1",
      JSON.stringify({
        "workspace-1:new": { text: "Keep this draft", updatedAt: 1 },
      }),
    );
    render(<App />);

    fireEvent.click(screen.getByRole("button", { name: "Automations" }));
    await screen.findByRole("heading", { name: "Automations" });
    fireEvent.click(screen.getByRole("button", { name: "New automation" }));

    expect(screen.getByTestId("composer-draft")).toHaveTextContent(
      /Current notes:\s*Keep this draft/,
    );
  });
});

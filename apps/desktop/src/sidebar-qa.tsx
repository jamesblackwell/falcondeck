/* Standalone sidebar fixture: `npm run dev` → /sidebar-qa.html.
   Renders the real DesktopSidebar with sample projects/threads covering the
   thread-row states (harness badge, pinned, running, unread, Stopped) so row
   layout and hover behavior can be screenshot without launching the app.
   `?theme=light|dark` picks the mode; `?width=200` narrows the sidebar;
   `?collapsed=workspace-1,workspace-2` folds projects shut to check the
   inline running/unread rollup on their rows. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import type {
  ProjectGroup,
  ThreadSummary,
  WorkspaceSummary,
} from "@falcondeck/client-core";
import { initAppearance, updateAppearance } from "@falcondeck/ui";

import { DesktopSidebar } from "./components/Sidebar";
import "./index.css";

initAppearance();
const params = new URLSearchParams(window.location.search);
const theme = params.get("theme");
if (theme === "light" || theme === "dark") {
  updateAppearance({ theme });
}
const width = Number(params.get("width")) || 280;
const collapsedWorkspaceIds = (params.get("collapsed") ?? "")
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

function workspace(overrides: Partial<WorkspaceSummary>): WorkspaceSummary {
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

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

function thread(overrides: Partial<ThreadSummary>): ThreadSummary {
  return {
    id: "thread-1",
    workspace_id: "workspace-1",
    title: "Main thread",
    provider: "codex",
    native_session_id: null,
    status: "idle",
    updated_at: minutesAgo(30),
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

const groups: ProjectGroup[] = [
  {
    workspace: workspace({
      id: "workspace-1",
      path: "/Users/james/falcondeck",
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
    threads: [
      thread({
        id: "thread-1",
        title: "Sidebar hover polish",
        provider: "codex",
        updated_at: minutesAgo(4),
      }),
      thread({
        id: "thread-2",
        title: "Relay reconnect audit with a very long title that truncates",
        provider: "claude",
        is_pinned_in_project: true,
        updated_at: minutesAgo(75),
      }),
      thread({
        id: "thread-3",
        title: "Dictation event sync",
        provider: "opencode",
        status: "running",
        updated_at: minutesAgo(1),
        attention: {
          level: "none",
          badge_label: null,
          unread: false,
          pending_approval_count: 0,
          pending_question_count: 0,
          last_agent_activity_seq: 3,
          last_read_seq: 3,
        },
      }),
      thread({
        id: "thread-4",
        title: "Kanban drag fix",
        provider: "acp-grok",
        updated_at: minutesAgo(60 * 26),
        attention: {
          level: "unread",
          badge_label: null,
          unread: true,
          pending_approval_count: 0,
          pending_question_count: 0,
          last_agent_activity_seq: 5,
          last_read_seq: 2,
        },
      }),
    ],
  },
  {
    workspace: workspace({
      id: "workspace-2",
      path: "/Users/james/www/sites/miner",
      current_thread_id: null,
    }),
    threads: [
      thread({
        id: "thread-5",
        workspace_id: "workspace-2",
        title: "Asteroid spawn balancing",
        provider: "claude",
        is_pinned: true,
        updated_at: minutesAgo(60 * 5),
      }),
      thread({
        id: "thread-7",
        workspace_id: "workspace-2",
        title: "Waiting on an approval",
        provider: "claude",
        updated_at: minutesAgo(3),
        attention: {
          level: "awaiting_response",
          badge_label: "Awaiting response",
          unread: true,
          pending_approval_count: 1,
          pending_question_count: 0,
          last_agent_activity_seq: 9,
          last_read_seq: 4,
        },
      }),
      thread({
        id: "thread-6",
        workspace_id: "workspace-2",
        title: "Stopped by shutdown",
        provider: "codex",
        status: "error",
        last_error: "FalconDeck was closed while this turn was running",
        updated_at: minutesAgo(60 * 49),
      }),
    ],
  },
];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="flex min-h-screen items-stretch bg-bg-0 p-6">
      <div
        style={{ width }}
        className="flex shrink-0 flex-col overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1"
      >
        <DesktopSidebar
          groups={groups}
          selectedWorkspaceId="workspace-1"
          selectedThreadId="thread-1"
          {...(collapsedWorkspaceIds.length > 0
            ? {
                // Controlled only when the query asks for it, so the rows stay
                // clickable in the default fixture.
                collapsedWorkspaceIds,
                onWorkspaceCollapsedChange: () => {},
              }
            : {})}
          onSelectWorkspace={() => {}}
          onSelectThread={() => {}}
          onRenameThread={async () => {}}
          onArchiveThread={async () => {}}
          onDeleteThread={async () => {}}
          onTogglePinThread={async () => {}}
          onTogglePinThreadInProject={async () => {}}
        />
      </div>
    </div>
  </StrictMode>,
);

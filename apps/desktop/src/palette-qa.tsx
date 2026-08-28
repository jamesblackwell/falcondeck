/* Standalone command-palette fixture: `npm run dev` → /palette-qa.html.
   Renders the real CommandPalette open over a blank shell with sample threads
   covering the browse sections (Needs attention, Recent, Actions, Appearance)
   so layout and the new-thread step can be screenshot without the app.
   `?theme=light|dark` picks the mode. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { CommandPalette } from "@falcondeck/chat-ui/command-palette";
import type {
  ProjectGroup,
  ThreadSummary,
  WorkspaceSummary,
} from "@falcondeck/client-core";
import { initAppearance, updateAppearance } from "@falcondeck/ui";

import "./index.css";

initAppearance();
const params = new URLSearchParams(window.location.search);
const theme = params.get("theme");
if (theme === "light" || theme === "dark") {
  updateAppearance({ theme });
}

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
    current_thread_id: null,
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
    queued_turns: [],
    variant: null,
    ...overrides,
  };
}

const unread = (seq: number) => ({
  level: "unread" as const,
  badge_label: null,
  unread: true,
  pending_approval_count: 0,
  pending_question_count: 0,
  last_agent_activity_seq: seq,
  last_read_seq: seq - 2,
});

const groups: ProjectGroup[] = [
  {
    workspace: workspace({ id: "workspace-1", path: "/Users/james/falcondeck" }),
    threads: [
      thread({
        id: "t1",
        title: "Optimize initial UI display speed",
        status: "running",
        attention: { ...unread(8), level: "running" },
        updated_at: minutesAgo(2),
      }),
      thread({
        id: "t2",
        title: "Improve plan readability",
        attention: unread(4),
        updated_at: minutesAgo(90),
      }),
      thread({
        id: "t3",
        title: "Needs approval: relay deploy",
        attention: {
          level: "awaiting_response",
          badge_label: "Awaiting response",
          unread: true,
          pending_approval_count: 1,
          pending_question_count: 0,
          last_agent_activity_seq: 4,
          last_read_seq: 2,
        },
        updated_at: minutesAgo(12),
      }),
      thread({
        id: "t4",
        title: "Sidebar hover polish",
        status: "running",
        updated_at: minutesAgo(1),
      }),
      thread({
        id: "t5",
        title: "Recording history and fallback transcription",
        updated_at: minutesAgo(60 * 5),
      }),
      thread({
        id: "t6",
        title: "Relay reconnect audit",
        updated_at: minutesAgo(60 * 26),
      }),
    ],
  },
  {
    workspace: workspace({ id: "workspace-2", path: "/Users/james/www/sites/miner" }),
    threads: [
      thread({
        id: "t7",
        workspace_id: "workspace-2",
        title: "Asteroid spawn balancing",
        updated_at: minutesAgo(60 * 49),
      }),
    ],
  },
  {
    workspace: workspace({ id: "workspace-3", path: "/Users/james/www/sites/quizgecko" }),
    threads: [],
  },
];

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="min-h-screen bg-bg-0">
      <CommandPalette
        groups={groups}
        onSelectThread={() => {}}
        onNewThread={() => {}}
        onOpenSettings={() => {}}
        onOpenUsage={() => {}}
        onOpenActivity={() => {}}
        onOpenKeyboardShortcuts={() => {}}
        onOpenPlugins={() => {}}
        openRequestKey={1}
        requestMode="open"
      />
    </div>
  </StrictMode>,
);

/* Standalone Activity fixture: `npm run dev` → /activity-qa.html.
   ?theme=light|dark and ?palette=<name> force an appearance for design QA. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { ActivityView } from "@falcondeck/chat-ui/activity-view";
import type {
  ActivityTail,
  InteractiveRequest,
  ProjectGroup,
  ThreadSummary,
  WorkspaceSummary,
} from "@falcondeck/client-core";
import { initAppearance } from "@falcondeck/ui";

import "./index.css";

const now = Date.now();
const ago = (minutes: number) =>
  new Date(now - minutes * 60_000).toISOString();

const workspace = (id: string, path: string) =>
  ({
    id,
    path,
    status: "ready",
    agents: [],
    default_provider: "codex",
    models: [],
    collaboration_modes: [],
    account: { status: "ready", label: "Ready" },
    current_thread_id: null,
    connected_at: ago(90),
    updated_at: ago(1),
    last_error: null,
  }) as unknown as WorkspaceSummary;

const thread = (
  workspaceId: string,
  overrides: Partial<ThreadSummary> & Pick<ThreadSummary, "id" | "title">,
): ThreadSummary =>
  ({
    workspace_id: workspaceId,
    provider: "codex",
    status: "idle",
    updated_at: ago(3),
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
  }) as unknown as ThreadSummary;

const unread = {
  level: "unread",
  badge_label: null,
  unread: true,
  pending_approval_count: 0,
  pending_question_count: 0,
  last_agent_activity_seq: 2,
  last_read_seq: 1,
} as ThreadSummary["attention"];

const errored = { ...unread, level: "error" } as ThreadSummary["attention"];
const runningAttention = {
  ...unread,
  level: "running",
  unread: false,
} as ThreadSummary["attention"];

const groups: ProjectGroup[] = [
  {
    workspace: workspace("ws-quizgecko", "/Users/james/www/sites/quizgecko"),
    threads: [
      thread("ws-quizgecko", {
        id: "t-blocked",
        title: "Migrate billing webhooks",
        updated_at: ago(0),
        // The blocked section is derived from pending requests, not attention.
        attention: { ...unread, pending_approval_count: 1 },
      }),
      thread("ws-quizgecko", {
        id: "t-ready",
        title: "Ping response handshake",
        updated_at: ago(0),
        last_message_preview: "Pong. How can I help?",
        attention: unread,
      }),
    ],
  },
  {
    workspace: workspace("ws-lucidpic", "/Users/james/www/sites/lucidpic"),
    threads: [
      thread("ws-lucidpic", {
        id: "t-failed",
        title: "Upgrade image pipeline",
        updated_at: ago(12),
        last_error: "Process exited 1 — vitest: 3 failed, 118 passed",
        attention: errored,
      }),
      thread("ws-lucidpic", {
        id: "t-run-1",
        title: "Community",
        status: "running",
        updated_at: ago(3),
        last_message_preview:
          "Collision cleared. Two tests assert the old auto-reject on the approve path — expanding both to cover the new guard before re-running.",
        attention: runningAttention,
      }),
      thread("ws-lucidpic", {
        id: "t-run-2",
        title: "Pricing and unlimited",
        status: "running",
        updated_at: ago(2),
        last_message_preview:
          "Restored. Let me verify the other high-risk guards genuinely fail too — the doubled quota path is the one I trust least.",
        attention: runningAttention,
      }),
    ],
  },
  {
    workspace: workspace("ws-falcondeck", "/Users/james/www/sites/falcondeck"),
    threads: [
      thread("ws-falcondeck", {
        id: "t-run-3",
        title: "this is such a long thread title it will truncate",
        status: "running",
        updated_at: ago(1),
        last_tool: "Working…",
        attention: runningAttention,
      }),
      thread("ws-falcondeck", {
        id: "t-done-1",
        title: "Wire the relay reconnect backoff",
        updated_at: ago(24),
        attention: { ...unread, unread: false, last_read_seq: 2 },
      }),
      thread("ws-falcondeck", {
        id: "finished-earlier",
        title: "Bump Expo SDK and re-run the export",
        updated_at: ago(95),
        attention: { ...unread, unread: false, last_read_seq: 2 },
      }),
      thread("ws-falcondeck", {
        id: "t-run-4",
        title: "why does this happen?",
        status: "running",
        updated_at: ago(0),
        last_tool: "Bash · rustup run stable cargo test -p falcondeck-core",
        attention: runningAttention,
      }),
    ],
  },
];

const requests: InteractiveRequest[] = [
  {
    request_id: "req-1",
    workspace_id: "ws-quizgecko",
    thread_id: "t-blocked",
    method: "command",
    kind: "approval",
    approval_decisions: ["allow", "deny"],
    title: "Run the billing migration?",
    detail: "The agent wants to apply 3 pending migrations to the dev database.",
    command: "npm run db:migrate -- --env=dev",
    path: "/Users/james/www/sites/quizgecko",
    turn_id: null,
    item_id: null,
    questions: [],
    created_at: ago(1),
  } as unknown as InteractiveRequest,
];

initAppearance();
const qaTheme = new URLSearchParams(window.location.search).get("theme");
if (qaTheme) document.documentElement.dataset.theme = qaTheme;
const qaPalette = new URLSearchParams(window.location.search).get("palette");
if (qaPalette) document.documentElement.dataset.palette = qaPalette;


/** A believable terminal readout per card, including one mid-stream. */
const tails: Record<string, ActivityTail> = {
  "ws-lucidpic:t-run-1": {
    seeded: true,
    lines: [
      { id: "u1", role: "user", text: "fix the collision on approve", streaming: false },
      { id: "t1", role: "tool", text: "rg -n 'auto-reject' src/", streaming: false },
      { id: "r1", role: "thinking", text: "two tests assert the old behaviour", streaming: false },
      { id: "t2", role: "tool", text: "npm test -- collision", streaming: false },
      { id: "a1", role: "agent", text: "Collision cleared. Expanding both tests to cover the new guard before re-run", streaming: true },
    ],
  },
  "ws-lucidpic:t-run-2": {
    seeded: true,
    lines: [
      { id: "u2", role: "user", text: "check the quota guards", streaming: false },
      { id: "t3", role: "tool", text: "npm test -- quota", streaming: false },
      { id: "e1", role: "error", text: "1 failed — doubled quota path", streaming: false },
      { id: "a2", role: "agent", text: "Restored. Verifying the other high-risk guards fail too", streaming: false },
    ],
  },
  "ws-falcondeck:t-run-3": {
    seeded: true,
    lines: [
      { id: "u3", role: "user", text: "add shortcut badges to the menus", streaming: false },
      { id: "t4", role: "tool", text: "sed -n '1,80p' src/components/Menu.tsx", streaming: true },
    ],
  },
  "ws-lucidpic:t-failed": {
    seeded: true,
    lines: [
      { id: "t5", role: "tool", text: "npx vitest run", streaming: false },
      { id: "e2", role: "error", text: "Process exited 1 — vitest: 3 failed, 118 passed", streaming: false },
    ],
  },
};

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="h-screen w-screen">
      <ActivityView
        groups={groups}
        interactiveRequests={requests}
        workspaceHosts={{
          "ws-quizgecko": { name: "quizgecko-ops-2", connected: true },
          "ws-lucidpic": { name: "studio-mac", connected: false },
        }}
        onOpenThread={() => {}}
        onInteractiveResponse={async () => {}}
        onMarkThreadRead={() => {}}
        threadTails={tails}
        onSendMessage={async () => {}}
        onClose={() => {}}
        onNewThread={() => {}}
      />
    </div>
  </StrictMode>,
);

/* Standalone Kanban board fixture: `npm run dev` → /kanban-qa.html.
   Renders the thread-tags extension board against an in-memory backend so
   drag-and-drop can be driven with real pointer input (Chrome CDP). Moves are
   recorded on window.__kanbanQa for assertions. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { collectExtensionApp } from "@falcondeck/extension-sdk/app";
import { initAppearance } from "@falcondeck/ui";

import kanbanApp from "../../../extensions/official/thread-tags/app";

import "./index.css";

type QaState = {
  moves: Array<{ threadId: string; stageId: string | null }>;
  openedThreads: string[];
};

const qa: QaState = { moves: [], openedThreads: [] };
(window as unknown as { __kanbanQa: QaState }).__kanbanQa = qa;

const threadStages: Record<string, string> = {
  "thread-1": "backlog",
  "thread-2": "in_progress",
};

const STAGES = [
  { id: "backlog", label: "Backlog", color: "gray" },
  { id: "in_progress", label: "In progress", color: "yellow" },
  { id: "done", label: "Done", color: "green" },
];

const thread = (
  id: string,
  title: string,
  { workspaceId = "workspace-1", daysAgo = 0 } = {},
) => ({
  id,
  workspaceId,
  title,
  status: "idle",
  updatedAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
  pendingApprovalCount: 0,
  pendingQuestionCount: 0,
});

const invokeAction = async (
  _actionId: string,
  input?: unknown,
  target?: { kind: string; id: string } | null,
) => {
  const operation = (input as { operation?: string } | undefined)?.operation;
  if (operation === "set_thread_stage" && target?.kind === "thread") {
    const stageId =
      (input as { stageId?: string | null }).stageId ?? null;
    if (stageId) threadStages[target.id] = stageId;
    else delete threadStages[target.id];
    qa.moves.push({ threadId: target.id, stageId });
  }
  return {
    result: { stages: STAGES, threadStages: { ...threadStages } },
    updatedViews: [],
  };
};

initAppearance();

const registration = collectExtensionApp(kanbanApp).panels[0]!;
const Board = registration.component;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="h-screen bg-surface-0">
      <Board
        extensionId="falcondeck.thread-tags"
        threads={[
          thread("thread-1", "Build the board"),
          thread("thread-2", "Review the board"),
          thread("thread-3", "Ship the board"),
          thread("thread-4", "Miner physics pass", {
            workspaceId: "workspace-2",
          }),
          thread("thread-5", "Stale forgotten session", { daysAgo: 30 }),
        ]}
        workspaces={[
          { id: "workspace-1", name: "falcondeck" },
          { id: "workspace-2", name: "miner" },
        ]}
        views={[]}
        hasPermission={(permission) => permission === "threads:read"}
        invokeAction={invokeAction}
        openThread={(_workspaceId, threadId) => {
          qa.openedThreads.push(threadId);
        }}
      />
    </div>
  </StrictMode>,
);

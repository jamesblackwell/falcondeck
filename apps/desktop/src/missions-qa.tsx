/* Standalone Missions fixture: `npm run dev` → /missions-qa.html.
   Use ?state=setup for incomplete permissions; the default renders a populated
   operational dashboard. Theme and palette query parameters match other QA
   fixtures. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import {
  collectExtensionApp,
  type ExtensionAppActionResponse,
} from "@falcondeck/extension-sdk/app";
import { initAppearance } from "@falcondeck/ui";

import missionsApp from "../../../extensions/official/missions/app";
import type { MissionPanelState } from "../../../extensions/official/missions/model";

import "./index.css";

const query = new URLSearchParams(window.location.search);
const qaTheme = query.get("theme");
const qaPalette = query.get("palette");
const setup = query.get("state") === "setup";

initAppearance();
if (qaTheme) document.documentElement.dataset.theme = qaTheme;
if (qaPalette) document.documentElement.dataset.palette = qaPalette;

const deadline = new Date(Date.now() + 24 * 60 * 1000).toISOString();
const updatedAt = new Date().toISOString();
const state: MissionPanelState = {
  schemaVersion: 1,
  runs: [
    {
      id: "run-release",
      workspaceId: "falcondeck",
      coordinatorThreadId: "coordinator-release",
      title: "Ship the Missions extension",
      objective:
        "Finish the coordinator workflow, verify its safety boundaries, and prepare a clear handoff.",
      gate: "open",
      policyRevision: 4,
      automaticTurnsStarted: 2,
      maxAutomaticTurns: 4,
      maxWorkers: 3,
      deadlineAt: deadline,
      completionProposed: false,
      status: "Workers running",
      checkpoint: {
        summary:
          "The coordinator completed the core implementation and delegated an independent verification pass.",
        nextAction: "Review the worker report and run the focused test suite.",
        evidence: ["Mission policy tests pass"],
        limitations: [],
      },
      workers: [
        {
          id: "worker-review-42",
          provider: "codex",
          status: "running",
          threadId: "worker-review",
        },
      ],
      hasUnknownOutcome: false,
      coordinatorSettling: false,
    },
    {
      id: "run-docs",
      workspaceId: "falcondeck",
      coordinatorThreadId: "coordinator-docs",
      title: "Reconcile the extension documentation",
      objective: "Check the shipping behavior against the canonical docs.",
      gate: "paused",
      pauseReason: "Waiting for a decision about the mobile fallback.",
      policyRevision: 2,
      automaticTurnsStarted: 1,
      maxAutomaticTurns: 4,
      maxWorkers: 3,
      deadlineAt: deadline,
      completionProposed: false,
      status: "Paused",
      checkpoint: {
        summary: "Desktop and remote behavior are reconciled.",
        evidence: [],
        limitations: ["Mobile uses the unsupported frontend fallback."],
        humanQuestion: "Should the mobile fallback include a link to desktop?",
      },
      workers: [],
      hasUnknownOutcome: false,
      coordinatorSettling: false,
    },
  ],
  drafts: [
    {
      id: "draft-review",
      workspaceId: "falcondeck",
      threadId: "draft-thread",
      title: "Run a release readiness review",
      objective: "Verify the extension against its acceptance criteria.",
      acceptanceCriteriaCount: 3,
      createdAt: updatedAt,
    },
  ],
  candidates: [
    {
      id: "candidate-1",
      workspaceId: "falcondeck",
      title: "Investigate intermittent reconnects",
      provider: "codex",
    },
    {
      id: "candidate-2",
      workspaceId: "falcondeck",
      title: "Plan the next extension API slice",
      provider: "claude",
    },
  ],
  updatedAt,
};

const view = {
  viewId: "missions-panel",
  value: state,
  updatedAt,
};
const invokeAction = async (): Promise<ExtensionAppActionResponse> => ({
  result: { refreshed: true },
  updatedViews: [view],
});

const Panel = collectExtensionApp(missionsApp).panels[0]!.component;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="flex h-screen flex-col bg-surface-0 text-fg-primary">
      <header className="flex h-14 shrink-0 items-center border-b border-border-default px-6">
        <h1 className="text-[length:var(--fd-text-lg)] font-semibold">
          Missions
        </h1>
      </header>
      <main className="min-h-0 flex-1">
        <Panel
          extensionId="falcondeck.missions"
          threads={[]}
          workspaces={[]}
          views={setup ? [] : [view]}
          hasPermission={(permission) =>
            setup ? permission === "threads:read" : true
          }
          invokeAction={invokeAction}
          openThread={() => {}}
          openExtensionSettings={() => {}}
        />
      </main>
    </div>
  </StrictMode>,
);

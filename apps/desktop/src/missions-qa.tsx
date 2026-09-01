/* Standalone Missions fixture: `npm run dev` → /missions-qa.html.
   Use ?state=setup for incomplete permissions; the default renders a populated
   long-horizon project dashboard. */
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

const updatedAt = new Date().toISOString();
const state: MissionPanelState = {
  schemaVersion: 2,
  missions: [
    {
      id: "mission-release",
      title: "Launch and observe FalconDeck Missions",
      brief:
        "Ship the durable project model, then collect real usage evidence over several weeks before expanding the orchestration surface.",
      successCriteria: [
        "The durable Mission record ships",
        "Agents can update it from linked tasks",
        "Follow-up evidence is recorded",
      ],
      status: "needs_human",
      threads: [
        {
          workspaceId: "falcondeck",
          threadId: "task-release",
          role: "source",
          linkedAt: updatedAt,
          title: "Implement Mission v2",
          provider: "codex",
          status: "idle",
        },
      ],
      updates: [
        {
          id: "update-1",
          actor: "agent",
          kind: "evidence",
          body: "The durable storage and task-bound tool tests pass.",
          threadId: "task-release",
          createdAt: updatedAt,
        },
        {
          id: "update-2",
          actor: "agent",
          kind: "question",
          body: "Should the first scheduled review run daily or weekly?",
          threadId: "task-release",
          createdAt: updatedAt,
        },
      ],
      createdAt: updatedAt,
      updatedAt,
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

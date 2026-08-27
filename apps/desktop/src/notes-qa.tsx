/* Standalone Notes fixture: `npm run dev` → /notes-qa.html.
   Renders the Notes extension panel against an in-memory library so the list
   column, editor, and preview can be driven with real input (Chrome CDP).
   ?theme=light|dark and ?palette=<name> force an appearance for design QA. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { collectExtensionApp } from "@falcondeck/extension-sdk/app";
import { initAppearance } from "@falcondeck/ui";

import notesApp from "../../../extensions/official/notes/app";

import "./index.css";

type Note = {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

const title = (body: string) =>
  body
    .split("\n")
    .map((line) => line.replace(/^\s*#{1,6}\s+/, "").trim())
    .find((line) => line !== "") ?? "New note";

const at = (daysAgo: number) =>
  new Date(Date.now() - daysAgo * 86_400_000).toISOString();

let notes: Note[] = [
  {
    id: "note-1",
    body: "# Release checklist\n\n- Cut the branch\n- Run `make test`\n- Tag and ship\n\n> Remember the TestFlight build.",
    title: "Release checklist",
    createdAt: at(3),
    updatedAt: at(0),
  },
  {
    id: "note-2",
    body: "Groceries\n\nOat milk, bread, olives, and something for Sunday.",
    title: "Groceries",
    createdAt: at(1),
    updatedAt: at(1),
  },
  {
    id: "note-3",
    body: "## Provider notes\n\nOpenCode efforts are *per model*. ACP only reveals them after the model is set.",
    title: "Provider notes",
    createdAt: at(9),
    updatedAt: at(4),
  },
];

const invokeAction = async (_actionId: string, input?: unknown) => {
  const request = input as { operation: string; id?: string; body?: string };
  if (request.operation === "create") {
    notes = [
      {
        id: `note-${notes.length + 1}`,
        body: request.body ?? "",
        title: "New note",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      ...notes,
    ];
  } else if (request.operation === "save") {
    notes = notes.map((note) =>
      note.id === request.id
        ? {
            ...note,
            body: request.body ?? "",
            title: title(request.body ?? ""),
            updatedAt: new Date().toISOString(),
          }
        : note,
    );
  } else if (request.operation === "delete") {
    notes = notes.filter((note) => note.id !== request.id);
  }
  return { result: { notes }, updatedViews: [] };
};

initAppearance();
const qaTheme = new URLSearchParams(window.location.search).get("theme");
if (qaTheme) document.documentElement.dataset.theme = qaTheme;
const qaPalette = new URLSearchParams(window.location.search).get("palette");
if (qaPalette) document.documentElement.dataset.palette = qaPalette;

const Panel = collectExtensionApp(notesApp).panels[0]!.component;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <div className="h-screen bg-surface-0">
      <Panel
        extensionId="falcondeck.notes"
        threads={[]}
        workspaces={[]}
        views={[]}
        hasPermission={() => false}
        invokeAction={invokeAction}
        openThread={() => {}}
      />
    </div>
  </StrictMode>,
);

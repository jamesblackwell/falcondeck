import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  collectExtensionApp,
  type ExtensionAppActionResponse,
  type ExtensionAppPanelProps,
} from "@falcondeck/extension-sdk/app";

import missionsApp from "../../../extensions/official/missions/app";
import {
  parseMissionPanelState,
  type MissionPanelState,
} from "../../../extensions/official/missions/model";

const permissions = [
  "threads:read",
  "agent-tools:register",
  "orchestration:manage-owned-tasks",
];

const panelState: MissionPanelState = {
  schemaVersion: 1,
  runs: [
    {
      id: "run-1",
      workspaceId: "workspace-1",
      coordinatorThreadId: "thread-1",
      title: "Release the Missions feature",
      objective: "Finish the implementation and verify the bounded workflow.",
      gate: "open",
      policyRevision: 3,
      automaticTurnsStarted: 1,
      maxAutomaticTurns: 4,
      maxWorkers: 3,
      deadlineAt: "2026-08-31T13:30:00.000Z",
      completionProposed: false,
      status: "Active",
      checkpoint: {
        summary: "The coordinator has implemented the first working slice.",
        evidence: [],
        limitations: [],
      },
      workers: [],
      hasUnknownOutcome: false,
      coordinatorSettling: false,
    },
  ],
  drafts: [
    {
      id: "draft-1",
      workspaceId: "workspace-1",
      threadId: "thread-2",
      title: "Review the release",
      objective: "Check the completed release against its acceptance criteria.",
      acceptanceCriteria: ["Review the code", "Report concrete evidence"],
      leaseMinutes: 180,
      maxAutomaticTurns: 12,
      maxWorkers: 3,
      createdAt: "2026-08-31T12:00:00.000Z",
    },
  ],
  candidates: [
    {
      id: "thread-3",
      workspaceId: "workspace-1",
      title: "Investigate the flaky test",
      provider: "codex",
    },
  ],
  updatedAt: "2026-08-31T12:30:00.000Z",
};

function response(state = panelState): ExtensionAppActionResponse {
  return {
    result: { refreshed: true },
    updatedViews: [
      {
        viewId: "missions-panel",
        value: state,
        updatedAt: state.updatedAt,
      },
    ],
  };
}

function renderMissions(
  overrides: Partial<ExtensionAppPanelProps> = {},
) {
  const Component = collectExtensionApp(missionsApp).panels[0]!.component;
  const props: ExtensionAppPanelProps = {
    extensionId: "falcondeck.missions",
    threads: [],
    views: [],
    hasPermission: () => false,
    invokeAction: vi.fn(async () => response()),
    openThread: vi.fn(),
    ...overrides,
  };
  render(<Component {...props} />);
  return props;
}

describe("Missions trusted frontend", () => {
  it("registers the Missions panel", () => {
    const registration = collectExtensionApp(missionsApp);
    expect(registration.extensionId).toBe("falcondeck.missions");
    expect(registration.panels[0]!.title).toBe("Missions");
    expect(registration.agentToolResults[0]!.toolId).toBe("draft-mission");
  });

  it("fails closed instead of silently hiding malformed mission entries", () => {
    expect(
      parseMissionPanelState({
        ...panelState,
        runs: [...panelState.runs, { id: "malformed-run" }],
      }),
    ).toBeNull();
  });

  it("shows a permission checklist without invoking an action that must fail", () => {
    const invokeAction = vi.fn(async () => response());
    const openExtensionSettings = vi.fn();
    renderMissions({
      hasPermission: (permission) => permission === "threads:read",
      invokeAction,
      openExtensionSettings,
    });

    expect(screen.getByText("Finish setting up Missions")).toBeVisible();
    expect(screen.getByText("Read tasks")).toBeVisible();
    expect(screen.getAllByText("Required")).toHaveLength(2);
    expect(invokeAction).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Open Extension settings" }),
    );
    expect(openExtensionSettings).toHaveBeenCalledOnce();
  });

  it("loads a compact dashboard and opens its coordinator task", async () => {
    const openThread = vi.fn();
    const invokeAction = vi.fn(async () => response());
    renderMissions({
      hasPermission: (permission) => permissions.includes(permission),
      invokeAction,
      openThread,
      views: response().updatedViews,
    });

    expect(screen.getByText("Release the Missions feature")).toBeVisible();
    expect(screen.getByText("Drafts to review")).toBeVisible();
    expect(screen.getByText("Investigate the flaky test")).toBeVisible();
    await waitFor(() =>
      expect(invokeAction).toHaveBeenCalledWith("refresh-missions", {}),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Open coordinator" }),
    );
    expect(openThread).toHaveBeenCalledWith("workspace-1", "thread-1");
  });

  it("opens a guided task for creating a new Mission", async () => {
    const startTask = vi.fn();
    const invokeAction = vi.fn(async () => response());
    renderMissions({
      hasPermission: (permission) => permissions.includes(permission),
      invokeAction,
      startTask,
      views: response().updatedViews,
    });
    await waitFor(() => expect(invokeAction).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "New mission" }));

    expect(startTask).toHaveBeenCalledOnce();
    expect(startTask).toHaveBeenCalledWith(
      expect.stringContaining(
        "use the FalconDeck Mission tools to create a draft for my review",
      ),
    );
  });

  it("disables new Mission creation when the host has no selected project", async () => {
    const invokeAction = vi.fn(async () => response());
    renderMissions({
      hasPermission: (permission) => permissions.includes(permission),
      invokeAction,
      views: response().updatedViews,
    });
    await waitFor(() => expect(invokeAction).toHaveBeenCalled());

    expect(screen.getByRole("button", { name: "New mission" })).toBeDisabled();
  });

  it("sends bounded run controls with the current policy revision", async () => {
    const invokeAction = vi.fn(async () => response());
    renderMissions({
      hasPermission: (permission) => permissions.includes(permission),
      invokeAction,
      views: response().updatedViews,
    });
    await waitFor(() => expect(invokeAction).toHaveBeenCalled());
    invokeAction.mockClear();

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() =>
      expect(invokeAction).toHaveBeenCalledWith("pause-run", {
        runId: "run-1",
        expectedPolicyRevision: 3,
      }),
    );
  });

  it("reviews, edits, and starts a draft from the agent-tool result", async () => {
    const registration = collectExtensionApp(missionsApp).agentToolResults[0]!;
    const Component = registration.component;
    const invokeAction = vi.fn(async (actionId: string) => ({
      result: { updated: true },
      updatedViews: actionId === "start-draft" ? [] : response().updatedViews,
    }));
    render(
      <Component
        extensionId="falcondeck.missions"
        toolId="draft-mission"
        arguments={{}}
        result={{
          ok: true,
          result: { draftId: "draft-1", status: "awaiting_human_start" },
        }}
        views={response().updatedViews}
        invokeAction={invokeAction}
      />,
    );

    expect(screen.getByText("Mission draft ready")).toBeVisible();
    expect(screen.getByText("3 hr")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Review and edit" }));
    fireEvent.change(screen.getByLabelText("Coordinator turns"), {
      target: { value: "18" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start mission" }));

    await waitFor(() => {
      expect(invokeAction).toHaveBeenNthCalledWith(
        1,
        "update-draft",
        expect.objectContaining({
          draftId: "draft-1",
          leaseMinutes: 180,
          maxAutomaticTurns: 18,
          maxWorkers: 3,
        }),
      );
      expect(invokeAction).toHaveBeenNthCalledWith(2, "start-draft", {
        draftId: "draft-1",
      });
    });
    expect(screen.getByText(/Mission started/)).toBeVisible();
  });
});

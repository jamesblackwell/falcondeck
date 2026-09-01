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

const permissions = ["threads:read", "agent-tools:register"];
const panelState: MissionPanelState = {
  schemaVersion: 2,
  missions: [
    {
      id: "mission-1",
      title: "Launch and observe the release",
      brief: "Publish the release and keep collecting evidence after launch.",
      successCriteria: ["Release is live", "Post-launch evidence is recorded"],
      status: "needs_human",
      threads: [
        {
          workspaceId: "workspace-1",
          threadId: "thread-1",
          role: "source",
          linkedAt: "2026-09-01T10:00:00.000Z",
          title: "Prepare the release",
          provider: "codex",
          status: "idle",
        },
      ],
      updates: [
        {
          id: "update-1",
          actor: "agent",
          kind: "question",
          body: "Which launch date should I use?",
          threadId: "thread-1",
          createdAt: "2026-09-01T12:00:00.000Z",
        },
      ],
      createdAt: "2026-09-01T10:00:00.000Z",
      updatedAt: "2026-09-01T12:00:00.000Z",
    },
  ],
  updatedAt: "2026-09-01T12:00:00.000Z",
};

function response(state = panelState): ExtensionAppActionResponse {
  return {
    result: { refreshed: true },
    updatedViews: [
      { viewId: "missions-panel", value: state, updatedAt: state.updatedAt },
    ],
  };
}

function renderMissions(overrides: Partial<ExtensionAppPanelProps> = {}) {
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

describe("Missions v2 trusted frontend", () => {
  it("registers the project panel and create tool result", () => {
    const registration = collectExtensionApp(missionsApp);
    expect(registration.panels[0]!.title).toBe("Missions");
    expect(registration.agentToolResults[0]!.toolId).toBe("create-mission");
  });

  it("fails closed on malformed Mission projections", () => {
    expect(
      parseMissionPanelState({ ...panelState, missions: [{ id: "broken" }] }),
    ).toBeNull();
  });

  it("shows only the two permissions Missions v2 uses", () => {
    const invokeAction = vi.fn(async () => response());
    renderMissions({
      hasPermission: (permission) => permission === "threads:read",
      invokeAction,
    });

    expect(screen.getByText("Finish setting up Missions")).toBeVisible();
    expect(screen.getByText("Read task summaries")).toBeVisible();
    expect(screen.getByText("Offer Mission tools")).toBeVisible();
    expect(invokeAction).not.toHaveBeenCalled();
  });

  it("renders the durable brief, updates, and linked tasks", async () => {
    const openThread = vi.fn();
    const invokeAction = vi.fn(async () => response());
    renderMissions({
      hasPermission: (permission) => permissions.includes(permission),
      invokeAction,
      openThread,
      views: response().updatedViews,
    });

    expect(screen.getByText("Launch and observe the release")).toBeVisible();
    expect(
      screen.getByText(/Missions keep larger outcomes visible/),
    ).toBeVisible();
    expect(screen.getByText("Which launch date should I use?")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: /Prepare the release/ }),
    );
    expect(openThread).toHaveBeenCalledWith("workspace-1", "thread-1");
    await waitFor(() =>
      expect(invokeAction).toHaveBeenCalledWith("refresh-missions", {}),
    );
  });

  it("starts a guided ordinary task for creating a Mission", async () => {
    const startTask = vi.fn();
    renderMissions({
      hasPermission: (permission) => permissions.includes(permission),
      startTask,
      views: response().updatedViews,
    });
    await waitFor(() =>
      expect(screen.getByText("Launch and observe the release")).toBeVisible(),
    );

    fireEvent.click(screen.getByRole("button", { name: "New mission" }));
    expect(startTask).toHaveBeenCalledWith(
      expect.stringContaining("call the FalconDeck create-mission tool"),
    );
  });

  it("posts human guidance and changes status through extension actions", async () => {
    const invokeAction = vi.fn(async () => response());
    renderMissions({
      hasPermission: (permission) => permissions.includes(permission),
      invokeAction,
      views: response().updatedViews,
    });

    fireEvent.change(screen.getByLabelText("Message Mission"), {
      target: { value: "Use next Tuesday." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Post update" }));
    await waitFor(() =>
      expect(invokeAction).toHaveBeenCalledWith("add-mission-update", {
        missionId: "mission-1",
        body: "Use next Tuesday.",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(invokeAction).toHaveBeenCalledWith("set-mission-status", {
        missionId: "mission-1",
        status: "paused",
      }),
    );
  });

  it("lets the human activate a draft inline", async () => {
    const registration = collectExtensionApp(missionsApp).agentToolResults[0]!;
    const Component = registration.component;
    const draftState: MissionPanelState = {
      ...panelState,
      missions: [{ ...panelState.missions[0]!, status: "draft" }],
    };
    const invokeAction = vi.fn(async () => response(draftState));
    render(
      <Component
        extensionId="falcondeck.missions"
        toolId="create-mission"
        arguments={{}}
        result={{
          ok: true,
          result: { missionId: "mission-1", status: "draft" },
        }}
        views={response(draftState).updatedViews}
        invokeAction={invokeAction}
      />,
    );

    expect(screen.getByText("Mission draft ready")).toBeVisible();
    expect(screen.getByText("No deadline")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Activate mission" }));
    await waitFor(() =>
      expect(invokeAction).toHaveBeenCalledWith("activate-mission", {
        missionId: "mission-1",
      }),
    );
  });
});

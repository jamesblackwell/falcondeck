import React from "react";
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
  "automations:manage-owned",
];
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
      automations: [],
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
    expect(registration.agentToolResults[0]!.detail).toEqual({
      title: "Mission",
    });
  });

  it("fails closed on malformed Mission projections", () => {
    expect(
      parseMissionPanelState({ ...panelState, missions: [{ id: "broken" }] }),
    ).toBeNull();
  });

  it("shows the permissions Missions v2 uses", () => {
    const invokeAction = vi.fn(async () => response());
    renderMissions({
      hasPermission: (permission) => permission === "threads:read",
      invokeAction,
    });

    expect(screen.getByText("Finish setting up Missions")).toBeVisible();
    expect(screen.getByText("Read task summaries")).toBeVisible();
    expect(screen.getByText("Offer Mission tools")).toBeVisible();
    expect(screen.getByText("Manage Mission check-ins")).toBeVisible();
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
        runNow: false,
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

  it("makes the recovery action start an agent and schedule future check-ins", async () => {
    const invokeAction = vi.fn(async () => response());
    renderMissions({
      hasPermission: (permission) => permissions.includes(permission),
      invokeAction,
      views: response().updatedViews,
    });

    fireEvent.change(
      screen.getByRole("combobox", {
        name: "Check-in cadence for Launch and observe the release",
      }),
      { target: { value: "30" } },
    );
    expect(screen.getByText("No agent has started")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Start agent now" }));
    await waitFor(() =>
      expect(invokeAction).toHaveBeenCalledWith("schedule-mission-review", {
        missionId: "mission-1",
        cadenceDays: 30,
        runImmediately: true,
      }),
    );
  });

  it("explains the separate elevated-Automation gate without blaming extension permissions", async () => {
    const invokeAction = vi.fn(async (actionId: string) => {
      if (actionId === "schedule-mission-review") {
        throw new Error(
          "This automation uses an elevated permission or sandbox mode, and elevated automations are disabled.",
        );
      }
      return response();
    });
    renderMissions({
      hasPermission: (permission) => permissions.includes(permission),
      invokeAction,
      views: response().updatedViews,
    });

    fireEvent.click(screen.getByRole("button", { name: "Start agent now" }));

    expect(
      await screen.findByText(/Enable ‘Allow elevated automations’/),
    ).toBeVisible();
    expect(
      screen.queryByText(/still needs permission setup/),
    ).not.toBeInTheDocument();
  });

  it("shows that a Mission created in chat has already started", async () => {
    const registration = collectExtensionApp(missionsApp).agentToolResults[0]!;
    const Component = registration.component;
    const invokeAction = vi.fn(async () => response(panelState));
    const openDetails = vi.fn();
    render(
      <Component
        extensionId="falcondeck.missions"
        toolId="create-mission"
        arguments={{}}
        result={{
          ok: true,
          result: {
            missionId: "mission-1",
            status: "active",
            firstCheckInQueued: true,
            checkInDays: 7,
          },
        }}
        views={response(panelState).updatedViews}
        presentation="inline"
        openDetails={openDetails}
        invokeAction={invokeAction}
      />,
    );

    expect(screen.getByText("Mission started")).toBeVisible();
    expect(screen.getByText(/agent check-in is queued now/)).toBeVisible();
    expect(screen.getByText("No deadline")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Open details" }));
    expect(openDetails).toHaveBeenCalledOnce();
    expect(invokeAction).not.toHaveBeenCalled();
  });
});

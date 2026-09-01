import { describe, expect, it } from "vitest";

import missions from "../../../extensions/official/missions/server";
import { createExtensionTestHost } from "./index";

const actions = [
  "refresh-missions",
  "activate-mission",
  "edit-mission",
  "add-mission-update",
  "set-mission-status",
  "schedule-mission-review",
  "control-mission-automation",
  "run-mission-review",
];
const permissions = [
  "threads:read",
  "agent-tools:register",
  "automations:manage-owned",
];

function host(storage?: Record<string, unknown>) {
  return createExtensionTestHost(missions, {
    extensionId: "falcondeck.missions",
    declaredActions: actions,
    declaredViews: ["missions-panel"],
    declaredTools: ["create-mission", "read-mission", "update-mission"],
    grantedPermissions: permissions,
    storage,
    threadSummaries: [
      {
        id: "thread-1",
        workspaceId: "workspace-1",
        title: "Plan the release",
        provider: "codex",
        status: "idle",
        updatedAt: "2026-09-01T10:00:00Z",
        pendingApprovalCount: 0,
        pendingQuestionCount: 0,
      },
      {
        id: "thread-2",
        workspaceId: "workspace-1",
        title: "Independent review",
        provider: "claude",
        status: "idle",
        updatedAt: "2026-09-01T11:00:00Z",
        pendingApprovalCount: 0,
        pendingQuestionCount: 0,
      },
    ],
  });
}

async function create(testHost = host()) {
  const response = await testHost.invokeTool("create-mission", {
    threadId: "thread-1",
    workspaceId: "workspace-1",
    input: {
      title: "Ship the release",
      brief: "Prepare, publish, and observe the release over time.",
      successCriteria: [
        "Release is published",
        "Post-release evidence is recorded",
      ],
    },
  });
  return {
    testHost,
    missionId: (response.result as { missionId: string }).missionId,
    response,
  };
}

describe("official Missions extension v2", () => {
  it("creates a durable draft linked to the daemon-verified calling task", async () => {
    const { testHost, missionId, response } = await create();

    expect(response.orchestrationEffects).toEqual([]);
    expect(response.automationEffects).toEqual([]);
    expect(response.result).toEqual({ missionId, status: "draft" });
    expect(testHost.storageSnapshot()).toEqual({
      missionsV2: {
        schemaVersion: 2,
        missions: [
          expect.objectContaining({
            id: missionId,
            status: "draft",
            threads: [
              expect.objectContaining({
                workspaceId: "workspace-1",
                threadId: "thread-1",
                role: "source",
              }),
            ],
          }),
        ],
      },
    });
  });

  it("publishes a compact attention view with linked native task metadata", async () => {
    const { testHost } = await create();
    const refreshed = await testHost.invokeAction("refresh-missions");

    expect(refreshed.publishedViews).toEqual([
      {
        viewId: "missions-panel",
        value: expect.objectContaining({
          schemaVersion: 2,
          missions: [
            expect.objectContaining({
              title: "Ship the release",
              threads: [
                expect.objectContaining({
                  title: "Plan the release",
                  provider: "codex",
                }),
              ],
            }),
          ],
        }),
      },
    ]);
  });

  it("requires a human action to activate and complete a Mission", async () => {
    const { testHost, missionId } = await create();

    await expect(
      testHost.invokeTool("update-mission", {
        threadId: "thread-1",
        workspaceId: "workspace-1",
        input: { missionId, operation: "set_status", status: "completed" },
      }),
    ).rejects.toThrow("agents cannot activate, complete, or cancel");

    const activated = await testHost.invokeAction("activate-mission", {
      input: { missionId },
    });
    expect(activated.result).toEqual({ missionId, status: "active" });

    const completed = await testHost.invokeAction("set-mission-status", {
      input: { missionId, status: "completed" },
    });
    expect(completed.result).toEqual({ missionId, status: "completed" });
  });

  it("lets a linked agent post evidence and link a verified existing task", async () => {
    const { testHost, missionId } = await create();
    await testHost.invokeAction("activate-mission", { input: { missionId } });

    await testHost.invokeTool("update-mission", {
      threadId: "thread-1",
      workspaceId: "workspace-1",
      input: {
        missionId,
        operation: "add_update",
        kind: "evidence",
        body: "The release build completed successfully.",
      },
    });
    await testHost.invokeTool("update-mission", {
      threadId: "thread-1",
      workspaceId: "workspace-1",
      input: {
        missionId,
        operation: "link_thread",
        threadId: "thread-2",
        role: "review",
      },
    });

    const read = await testHost.invokeTool("read-mission", {
      threadId: "thread-1",
      workspaceId: "workspace-1",
      input: { missionId },
    });
    expect(read.result).toEqual(
      expect.objectContaining({
        threads: expect.arrayContaining([
          expect.objectContaining({ threadId: "thread-2", role: "review" }),
        ]),
        updates: expect.arrayContaining([
          expect.objectContaining({
            actor: "agent",
            kind: "evidence",
            body: "The release build completed successfully.",
          }),
        ]),
      }),
    );
  });

  it("rejects a tool caller that is not linked to the Mission", async () => {
    const { testHost, missionId } = await create();

    await expect(
      testHost.invokeTool("read-mission", {
        threadId: "thread-2",
        workspaceId: "workspace-1",
        input: { missionId },
      }),
    ).rejects.toThrow("this task is not linked to that Mission");
  });

  it("creates a review Automation from a verified linked task", async () => {
    const { testHost, missionId } = await create();
    await testHost.invokeAction("activate-mission", { input: { missionId } });

    const scheduled = await testHost.invokeAction("schedule-mission-review", {
      input: { missionId, cadenceDays: 7 },
    });

    expect(scheduled.automationEffects).toEqual([
      expect.objectContaining({
        type: "create_from_thread",
        resourceId: missionId,
        sourceWorkspaceId: "workspace-1",
        sourceThreadId: "thread-1",
        trigger: expect.objectContaining({
          kind: "interval",
          every_seconds: 604800,
        }),
        misfirePolicy: "run_once",
      }),
    ]);
  });

  it("authorizes and links a fresh Automation task using daemon provenance", async () => {
    const { testHost, missionId } = await create();

    const read = await testHost.invokeTool("read-mission", {
      threadId: "thread-automation",
      workspaceId: "workspace-1",
      automationOwnerResourceId: missionId,
      input: { missionId },
    });

    expect(read.result).toEqual(
      expect.objectContaining({
        threads: expect.arrayContaining([
          expect.objectContaining({
            threadId: "thread-automation",
            role: "review",
          }),
        ]),
      }),
    );
  });

  it("does not resume or run reviews while the Mission is paused", async () => {
    const { testHost, missionId } = await create();
    await testHost.invokeAction("activate-mission", { input: { missionId } });
    testHost.setOwnedAutomations([
      {
        id: "automation-1",
        resourceId: missionId,
        revision: 3,
        name: "Mission review",
        state: "paused",
        provider: "codex",
        resolvedSchedule: "Every 7 days",
      },
    ]);
    const paused = await testHost.invokeAction("set-mission-status", {
      input: { missionId, status: "paused" },
    });
    expect(paused.automationEffects).toEqual([
      { type: "pause_resource", resourceId: missionId },
    ]);

    await expect(
      testHost.invokeAction("control-mission-automation", {
        input: { missionId, operation: "resume" },
      }),
    ).rejects.toThrow("activate the Mission before resuming its reviews");
    await expect(
      testHost.invokeAction("run-mission-review", {
        input: { missionId },
      }),
    ).rejects.toThrow("activate the Mission before requesting a review");
  });

  it("migrates legacy drafts without starting legacy orchestration", async () => {
    const testHost = host({
      missionDrafts: [
        {
          id: "legacy-draft",
          workspaceId: "workspace-1",
          threadId: "thread-1",
          title: "Legacy draft",
          objective: "Preserve this brief",
          acceptanceCriteria: ["Brief survives"],
          createdAt: "2026-08-31T10:00:00Z",
        },
      ],
    });

    const refreshed = await testHost.invokeAction("refresh-missions");
    expect(refreshed.orchestrationEffects).toEqual([]);
    expect(testHost.storageSnapshot()).toEqual({
      missionsV2: {
        schemaVersion: 2,
        missions: [
          expect.objectContaining({ id: "legacy-draft", status: "draft" }),
        ],
      },
    });
  });
});

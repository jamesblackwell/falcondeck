import { describe, expect, it } from "vitest";

import missions from "../../../extensions/official/missions/server";
import type { ExtensionRunSummary } from "@falcondeck/extension-sdk";
import { createExtensionTestHost } from "./index";

const actions = [
  "refresh-missions",
  "start-draft",
  "adopt-task",
  "pause-run",
  "resume-run",
  "extend-run",
  "accept-completion",
  "close-incomplete",
];
const permissions = [
  "threads:read",
  "agent-tools:register",
  "orchestration:manage-owned-tasks",
];

function openRun(): ExtensionRunSummary {
  return {
    id: "run-1",
    ownerExtensionId: "falcondeck.missions",
    workspaceId: "workspace-1",
    coordinatorThreadId: "thread-1",
    title: "Ship the feature",
    objective: "Implement and verify the feature",
    gate: "open",
    checkpoint: {
      schemaVersion: 1,
      objective: "Implement and verify the feature",
      acceptanceCriteria: ["Focused tests pass"],
      disposition: "planning",
      summary: "",
      evidence: [],
      limitations: [],
      updatedAt: "2026-08-30T10:00:00Z",
    },
    policyRevision: 3,
    journalSequence: 2,
    approvalGeneration: 1,
    automaticTurnsStarted: 1,
    maxAutomaticTurns: 4,
    createdAt: "2026-08-30T10:00:00Z",
    updatedAt: "2026-08-30T10:01:00Z",
    deadlineAt: "2026-08-30T10:30:00Z",
    completionProposed: false,
    operations: [],
  };
}

function host(runs: ExtensionRunSummary[] = []) {
  return createExtensionTestHost(missions, {
    extensionId: "falcondeck.missions",
    declaredActions: actions,
    declaredViews: ["missions-panel"],
    declaredTools: ["draft-mission", "mission-status", "mission-checkpoint"],
    grantedPermissions: permissions,
    orchestrationRuns: runs,
    threadSummaries: [
      {
        id: "thread-1",
        workspaceId: "workspace-1",
        title: "Ship the feature",
        provider: "claude",
        status: "idle",
        updatedAt: "2026-08-30T10:00:00Z",
        pendingApprovalCount: 0,
        pendingQuestionCount: 0,
      },
    ],
  });
}

describe("official Missions extension", () => {
  it("creates only a draft from the agent and requires a human start action", async () => {
    const testHost = host();
    const drafted = await testHost.invokeTool("draft-mission", {
      threadId: "thread-1",
      workspaceId: "workspace-1",
      input: {
        title: "Ship the feature",
        objective: "Implement and verify the feature",
        acceptanceCriteria: ["Focused tests pass"],
      },
    });
    expect(drafted.orchestrationEffects).toEqual([]);
    const draftId = (drafted.result as { draftId: string }).draftId;

    const started = await testHost.invokeAction("start-draft", {
      input: { draftId },
    });
    expect(started.orchestrationEffects).toEqual([
      expect.objectContaining({
        type: "create_run",
        workspaceId: "workspace-1",
        coordinatorThreadId: "thread-1",
      }),
    ]);
    expect(testHost.storageSnapshot()).toEqual({
      missionDrafts: [expect.objectContaining({ id: draftId })],
    });

    testHost.setOrchestrationRuns([openRun()]);
    await testHost.dispatchEvent({
      type: "orchestration.updated",
      workspaceId: "workspace-1",
      runId: "run-1",
    });
    expect(testHost.storageSnapshot()).toEqual({ missionDrafts: [] });
  });

  it("turns one coordinator checkpoint into one bounded successor intent", async () => {
    const testHost = host([openRun()]);
    const checkpoint = await testHost.invokeTool("mission-checkpoint", {
      threadId: "thread-1",
      workspaceId: "workspace-1",
      input: {
        disposition: "continue_self",
        summary: "Implemented the core path",
        nextAction: "Run the focused test",
        progressFingerprint: "core-implemented-v1",
      },
    });
    expect(checkpoint.orchestrationEffects).toEqual([
      expect.objectContaining({
        type: "request_continuation",
        runId: "run-1",
        expectedPolicyRevision: 3,
        progressFingerprint: "core-implemented-v1",
      }),
    ]);
  });

  it("denies the run facet immediately after permission revocation", async () => {
    const testHost = host([openRun()]);
    testHost.setPermissionGranted(
      "orchestration:manage-owned-tasks",
      false,
    );
    await expect(testHost.invokeAction("refresh-missions")).rejects.toThrow(
      "orchestration:manage-owned-tasks permission is not granted",
    );
  });
});

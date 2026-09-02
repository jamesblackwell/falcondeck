import { describe, expect, it } from "vitest";

import miniZen from "../../../extensions/official/mini-zen/server";
import { createExtensionTestHost } from "./index";

describe("official Mini Zen extension", () => {
  it("combines attention events with granted summary-only thread reads", async () => {
    const host = createExtensionTestHost(miniZen, {
      extensionId: "falcondeck.mini-zen",
      declaredActions: [],
      declaredViews: ["attention-panel"],
      grantedPermissions: ["threads:read"],
      threadSummaries: [
        {
          id: "thread-1",
          workspaceId: "workspace-1",
          title: "Review the release",
          provider: "claude",
          status: "waiting_for_input",
          updatedAt: "2026-08-13T08:00:00Z",
          pendingApprovalCount: 1,
          pendingQuestionCount: 0,
        },
      ],
    });

    await host.dispatchEvent({
      type: "attention.opened",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      requestId: "request-1",
    });

    expect(host.diagnosticSnapshot()).toEqual([
      { level: "info", message: "Mini Zen activated" },
    ]);
    expect(host.storageSnapshot()).toEqual({
      pendingAttention: [
        {
          workspaceId: "workspace-1",
          threadId: "thread-1",
          requestId: "request-1",
        },
      ],
    });
    expect(host.publishedViewSnapshot()).toEqual([
      expect.objectContaining({
        viewId: "attention-panel",
        value: expect.objectContaining({ version: 1 }),
      }),
    ]);
    expect(JSON.stringify(host.publishedViewSnapshot())).toContain(
      "Review the release",
    );

    host.setPermissionGranted("threads:read", false);
    expect(host.publishedViewSnapshot()).toEqual([]);
    await host.dispatchEvent({
      type: "thread.updated",
      workspaceId: "workspace-1",
      threadId: "thread-1",
    });
    expect(JSON.stringify(host.publishedViewSnapshot())).toContain(
      "A thread needs attention",
    );

    await host.dispatchEvent({
      type: "attention.resolved",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      requestId: "request-1",
    });
    expect(host.storageSnapshot()).toEqual({ pendingAttention: [] });
  });

  it("keeps the id-only fallback usable before the grant", async () => {
    const host = createExtensionTestHost(miniZen, {
      extensionId: "falcondeck.mini-zen",
      declaredViews: ["attention-panel"],
    });

    await expect(
      host.dispatchEvent({
        type: "attention.opened",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        requestId: "request-1",
      }),
    ).resolves.toBeDefined();
    expect(JSON.stringify(host.publishedViewSnapshot())).toContain(
      "A thread needs attention",
    );
  });

  it("serializes concurrent attention changes without losing an item", async () => {
    const host = createExtensionTestHost(miniZen, {
      extensionId: "falcondeck.mini-zen",
      declaredViews: ["attention-panel"],
    });

    await Promise.all([
      host.dispatchEvent({
        type: "attention.opened",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        requestId: "request-1",
      }),
      host.dispatchEvent({
        type: "attention.opened",
        workspaceId: "workspace-1",
        threadId: "thread-2",
        requestId: "request-2",
      }),
    ]);

    expect(host.storageSnapshot().pendingAttention).toHaveLength(2);
  });
});

import { describe, expect, it } from "vitest";

import miniZen from "../../../extensions/official/mini-zen/server";
import { createExtensionTestHost } from "./index";

describe("official Mini Zen extension", () => {
  it("tracks identifier-only attention events through the public SDK", async () => {
    const host = createExtensionTestHost(miniZen, {
      extensionId: "falcondeck.mini-zen",
      declaredActions: [],
      declaredViews: ["attention-panel"],
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

    await host.dispatchEvent({
      type: "attention.resolved",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      requestId: "request-1",
    });
    expect(host.storageSnapshot()).toEqual({ pendingAttention: [] });
  });
});

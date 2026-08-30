import { describe, expect, it } from "vitest";

import {
  defineExtension,
  type ExtensionEventType,
} from "@falcondeck/extension-sdk";

import { createExtensionTestHost } from "./index";

function counterExtension() {
  return defineExtension({
    activate(context) {
      context.actions.register<{ increment: number }>(
        "increment",
        async ({ input }) => {
          const count =
            (await context.storage.get("count", 0)) + input.increment;
          await context.storage.set("count", count);
          await context.views.publish({ viewId: "counter", value: { count } });
          context.log.info("counter changed", { count });
          return { count };
        },
      );
    },
  });
}

describe("ExtensionTestHost", () => {
  it("activates once and returns action storage and view effects", async () => {
    const host = createExtensionTestHost(counterExtension(), {
      storage: { count: 2 },
    });

    const result = await host.invokeAction("increment", {
      input: { increment: 3 },
    });

    expect(result).toEqual({
      result: { count: 5 },
      storage: { count: 5 },
      publishedViews: [{ viewId: "counter", value: { count: 5 } }],
      orchestrationEffects: [],
    });
  });

  it("records structured diagnostics without exposing mutable references", async () => {
    const host = createExtensionTestHost(counterExtension());
    await host.invokeAction("increment", { input: { increment: 1 } });

    expect(host.diagnosticSnapshot()).toEqual([
      { level: "info", message: "counter changed", fields: { count: 1 } },
    ]);
  });

  it("injects one isolated action failure", async () => {
    const host = createExtensionTestHost(counterExtension());
    host.failNextAction("fixture crash");

    await expect(
      host.invokeAction("increment", { input: { increment: 1 } }),
    ).rejects.toThrow("fixture crash");
    await expect(
      host.invokeAction("increment", { input: { increment: 1 } }),
    ).resolves.toMatchObject({
      result: { count: 1 },
    });
  });

  it("rolls activation effects back and retries a failed activation cleanly", async () => {
    let attempts = 0;
    const extension = defineExtension({
      async activate(context) {
        attempts += 1;
        await context.storage.set("activation-attempt", attempts);
        context.actions.register("run", () => "ok");
        if (attempts === 1) throw new Error("activation failed");
      },
    });
    const host = createExtensionTestHost(extension);

    await expect(host.invoke("run")).rejects.toThrow("activation failed");
    expect(host.storageSnapshot()).toEqual({});
    await expect(host.invoke("run")).resolves.toMatchObject({ result: "ok" });
    expect(host.storageSnapshot()).toEqual({ "activation-attempt": 2 });
  });

  it("rolls private storage back when a view violates the manifest contract", async () => {
    const host = createExtensionTestHost(counterExtension(), {
      declaredActions: ["increment"],
      declaredViews: ["different-view"],
    });

    await expect(
      host.invokeAction("increment", { input: { increment: 1 } }),
    ).rejects.toThrow("undeclared view");
    expect(host.storageSnapshot()).toEqual({});
  });

  it("rejects non-JSON storage values like the real host boundary", async () => {
    const extension = defineExtension({
      activate(context) {
        context.actions.register("write", () =>
          context.storage.set("invalid", undefined),
        );
      },
    });
    const host = createExtensionTestHost(extension);

    await expect(host.invoke("write")).rejects.toThrow("JSON-serializable");
  });

  it("commits retained projections by view and scope only after success", async () => {
    const host = createExtensionTestHost(counterExtension(), {
      declaredViews: ["counter"],
    });

    await host.invoke("increment", { input: { increment: 1 } });
    await host.invoke("increment", { input: { increment: 2 } });

    expect(host.publishedViewSnapshot()).toEqual([
      { viewId: "counter", value: { count: 3 } },
    ]);
  });

  it("rejects oversized host responses atomically", async () => {
    const extension = defineExtension({
      activate(context) {
        context.actions.register("oversized", async () => {
          await context.storage.set("started", true);
          return "x".repeat(2 * 1024 * 1024);
        });
      },
    });
    const host = createExtensionTestHost(extension);

    await expect(host.invoke("oversized")).rejects.toThrow(
      "host response exceeds",
    );
    expect(host.storageSnapshot()).toEqual({});
  });

  it("delivers typed lifecycle events and commits their effects", async () => {
    const extension = defineExtension({
      activate(context) {
        context.events.on("attention.opened", async (event) => {
          await context.storage.set("requestId", event.requestId);
          await context.views.publish({
            viewId: "attention",
            value: { threadId: event.threadId, requestId: event.requestId },
          });
        });
      },
    });
    const host = createExtensionTestHost(extension, {
      declaredViews: ["attention"],
    });

    await host.dispatchEvent({
      type: "attention.opened",
      workspaceId: "workspace-1",
      threadId: "thread-1",
      requestId: "request-1",
    });

    expect(host.storageSnapshot()).toEqual({ requestId: "request-1" });
    expect(host.publishedViewSnapshot()).toEqual([
      {
        viewId: "attention",
        value: { threadId: "thread-1", requestId: "request-1" },
      },
    ]);
  });

  it("rolls event effects back atomically after a handler failure", async () => {
    let shouldFail = true;
    const extension = defineExtension({
      activate(context) {
        context.events.on("thread.updated", async ({ threadId }) => {
          await context.storage.set("threadId", threadId);
          if (shouldFail) {
            shouldFail = false;
            throw new Error("event failed");
          }
        });
      },
    });
    const host = createExtensionTestHost(extension);
    const event = {
      type: "thread.updated" as const,
      workspaceId: "workspace-1",
      threadId: "thread-1",
    };

    await expect(host.dispatchEvent(event)).rejects.toThrow("event failed");
    expect(host.storageSnapshot()).toEqual({});
    await expect(host.dispatchEvent(event)).resolves.toMatchObject({
      storage: { threadId: "thread-1" },
    });
  });

  it("stops delivering to a disposed event subscription", async () => {
    const deliveries: string[] = [];
    const extension = defineExtension({
      activate(context) {
        const disposed = context.events.on("thread.updated", ({ threadId }) => {
          deliveries.push(`disposed:${threadId}`);
        });
        context.events.on("thread.updated", ({ threadId }) => {
          deliveries.push(`active:${threadId}`);
        });
        disposed.dispose();
        disposed.dispose();
      },
    });
    const host = createExtensionTestHost(extension);

    await host.dispatchEvent({
      type: "thread.updated",
      workspaceId: "workspace-1",
      threadId: "thread-1",
    });

    expect(deliveries).toEqual(["active:thread-1"]);
  });

  it("rejects unsupported event subscription names at the host boundary", async () => {
    const extension = defineExtension({
      activate(context) {
        context.events.on("future.event" as ExtensionEventType, () => {});
      },
    });

    await expect(createExtensionTestHost(extension).activate()).rejects.toThrow(
      "unsupported extension event type",
    );
  });

  it("denies thread reads by default and reduces granted summaries", async () => {
    const observed: unknown[] = [];
    const extension = defineExtension({
      activate(context) {
        context.events.on("thread.updated", async () => {
          observed.push(await context.threads.list());
        });
      },
    });
    const summary = {
      id: "thread-1",
      workspaceId: "workspace-1",
      title: "Needs review",
      provider: "claude",
      status: "waiting_for_input" as const,
      updatedAt: "2026-08-13T08:00:00Z",
      pendingApprovalCount: 1,
      pendingQuestionCount: 0,
      transcript: "must not cross the boundary",
      lastMessagePreview: "also private",
    };
    const host = createExtensionTestHost(extension, {
      threadSummaries: [summary],
    });
    const event = {
      type: "thread.updated" as const,
      workspaceId: "workspace-1",
      threadId: "thread-1",
    };

    await expect(host.dispatchEvent(event)).rejects.toThrow(
      "threads:read permission is not granted",
    );
    host.setPermissionGranted("threads:read", true);
    await host.dispatchEvent(event);

    expect(observed).toEqual([
      [
        {
          id: "thread-1",
          workspaceId: "workspace-1",
          title: "Needs review",
          provider: "claude",
          status: "waiting_for_input",
          updatedAt: "2026-08-13T08:00:00Z",
          pendingApprovalCount: 1,
          pendingQuestionCount: 0,
        },
      ],
    ]);

    host.setThreadSummaries(
      Array.from({ length: 1_005 }, (_, index) => ({
        id: `thread-${index}`,
        workspaceId: "workspace-1",
        title: "x".repeat(300),
        provider: "claude",
        status: "idle" as const,
        updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        pendingApprovalCount: 0,
        pendingQuestionCount: 0,
      })),
    );
    await host.dispatchEvent(event);
    const bounded = observed[1] as Array<{ id: string; title: string }>;
    expect(bounded).toHaveLength(1_000);
    expect(bounded[0]?.id).toBe("thread-1004");
    expect(Array.from(bounded[0]?.title ?? "")).toHaveLength(256);
  });
});

import { describe, expect, it } from "vitest";

import { defineExtension } from "@falcondeck/extension-sdk";

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
});

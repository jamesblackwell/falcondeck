import { describe, expect, it } from "vitest";

import threadTags from "../../../extensions/official/thread-tags/server";

import { createExtensionTestHost } from "./index";

describe("Thread Stages public SDK contract", () => {
  it("persists a stage and publishes only manifest-declared projections", async () => {
    const host = await createExtensionTestHost(threadTags, {
      extensionId: "falcondeck.thread-tags",
      declaredActions: ["manage-tags"],
      declaredViews: ["tag-index", "thread-tags"],
    });

    const result = await host.invokeAction("manage-tags", {
      target: { kind: "thread", id: "thread-1" },
      input: { operation: "set_thread_stage", stageId: "in_progress" },
    });

    expect(result.storage.threadStages).toEqual({ "thread-1": "in_progress" });
    expect(result.publishedViews).toEqual(
      expect.arrayContaining([
        {
          viewId: "thread-tags",
          scope: { kind: "thread", id: "thread-1" },
          value: { tagIds: ["in_progress"] },
        },
        expect.objectContaining({
          viewId: "tag-index",
          value: expect.objectContaining({
            tags: expect.arrayContaining([
              expect.objectContaining({ id: "in_progress", label: "In progress" }),
            ]),
          }),
        }),
      ]),
    );
  });

  it("creates a custom stage and assigns it to the target thread", async () => {
    const host = await createExtensionTestHost(threadTags, {
      extensionId: "falcondeck.thread-tags",
      declaredActions: ["manage-tags"],
      declaredViews: ["tag-index", "thread-tags"],
    });

    const result = await host.invokeAction("manage-tags", {
      target: { kind: "thread", id: "thread-1" },
      input: { operation: "create_stage", label: "Blocked" },
    });

    expect(result.storage.threadStages).toEqual({ "thread-1": "blocked" });
    expect(result.publishedViews).toEqual(
      expect.arrayContaining([
        {
          viewId: "thread-tags",
          scope: { kind: "thread", id: "thread-1" },
          value: { tagIds: ["blocked"] },
        },
        expect.objectContaining({
          viewId: "tag-index",
          value: expect.objectContaining({
            tags: expect.arrayContaining([
              expect.objectContaining({
                id: "blocked",
                label: "Blocked",
                icon: "custom",
              }),
            ]),
          }),
        }),
      ]),
    );
  });
});

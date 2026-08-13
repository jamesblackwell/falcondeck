import { describe, expect, it } from "vitest";

import threadTags from "../../../extensions/official/thread-tags/server";

import { createExtensionTestHost } from "./index";

describe("Thread Colours public SDK contract", () => {
  it("persists a colour and publishes only manifest-declared projections", async () => {
    const host = await createExtensionTestHost(threadTags, {
      extensionId: "falcondeck.thread-tags",
      declaredActions: ["manage-tags"],
      declaredViews: ["tag-index", "thread-tags"],
    });

    const result = await host.invokeAction("manage-tags", {
      target: { kind: "thread", id: "thread-1" },
      input: { operation: "set_thread_color", color: "red" },
    });

    expect(result.storage).toEqual({ threadColors: { "thread-1": "red" } });
    expect(result.publishedViews).toEqual(
      expect.arrayContaining([
        {
          viewId: "thread-tags",
          scope: { kind: "thread", id: "thread-1" },
          value: { tagIds: ["red"] },
        },
        expect.objectContaining({ viewId: "tag-index" }),
      ]),
    );
  });
});

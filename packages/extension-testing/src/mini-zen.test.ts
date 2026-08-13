import { describe, expect, it } from "vitest";

import miniZen from "../../../extensions/official/mini-zen/server";
import { createExtensionTestHost } from "./index";

describe("official Mini Zen extension", () => {
  it("activates through the public SDK and fake host", async () => {
    const host = createExtensionTestHost(miniZen, {
      extensionId: "falcondeck.mini-zen",
      declaredActions: [],
      declaredViews: ["attention-panel"],
    });

    await host.activate();

    expect(host.diagnosticSnapshot()).toEqual([
      { level: "info", message: "Mini Zen activated" },
    ]);
  });
});

import { describe, expect, it } from "vitest";

import { defineExtensionUi } from "./index";

describe("defineExtensionUi", () => {
  it("preserves literal component and binding identifiers", () => {
    const document = defineExtensionUi({
      version: 1,
      root: {
        type: "button",
        label: "Refresh",
        action: { actionId: "refresh", input: { source: "panel" } },
      },
    });

    expect(document.root.type).toBe("button");
    expect(document.root.action.actionId).toBe("refresh");
  });
});

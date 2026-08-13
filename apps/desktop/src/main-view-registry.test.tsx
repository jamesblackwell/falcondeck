import { describe, expect, it } from "vitest";

import { resolveMainView } from "./main-view-registry";

describe("resolveMainView", () => {
  it("resolves a registered main-area takeover by id", () => {
    const activity = <section>Activity</section>;

    expect(
      resolveMainView(
        {
          "core.activity": activity,
          "core.settings": <section>Settings</section>,
        },
        "core.activity",
      ),
    ).toBe(activity);
  });

  it("returns null when no registered view is active", () => {
    expect(resolveMainView({ "core.activity": <section /> }, null)).toBeNull();
    expect(
      resolveMainView({ "core.activity": <section /> }, "extension.missing"),
    ).toBeNull();
  });
});

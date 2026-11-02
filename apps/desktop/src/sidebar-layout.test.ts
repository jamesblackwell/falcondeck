import { beforeEach, describe, expect, it } from "vitest";

import { readSidebarLayout, writeSidebarLayout } from "./sidebar-layout";

describe("sidebar layout preference", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to classic and persists bot-focused", () => {
    expect(readSidebarLayout()).toBe("classic");
    writeSidebarLayout("bots");
    expect(readSidebarLayout()).toBe("bots");
    writeSidebarLayout("classic");
    expect(readSidebarLayout()).toBe("classic");
  });

  it("treats unknown values as classic", () => {
    localStorage.setItem("falcondeck.sidebar-layout", "weird");
    expect(readSidebarLayout()).toBe("classic");
  });
});

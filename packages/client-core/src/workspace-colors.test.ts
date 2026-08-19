import { describe, expect, it } from "vitest";

import {
  isWorkspaceColorId,
  normalizeWorkspaceColors,
  workspaceColorCssVar,
} from "./workspace-colors";

describe("workspace colors", () => {
  it("accepts the twelve categorical tokens and rejects everything else", () => {
    expect(isWorkspaceColorId("cat-1")).toBe(true);
    expect(isWorkspaceColorId("cat-12")).toBe(true);
    expect(isWorkspaceColorId("cat-0")).toBe(false);
    expect(isWorkspaceColorId("#f87171")).toBe(false);
    expect(isWorkspaceColorId(null)).toBe(false);
  });

  it("drops blank ids, unknown tokens, and later duplicates", () => {
    expect(
      normalizeWorkspaceColors({
        " workspace-a ": "cat-3",
        "workspace-b": "red",
        "": "cat-1",
        "workspace-a": "cat-8",
        "workspace-c": "cat-12",
      }),
    ).toEqual({
      "workspace-a": "cat-3",
      "workspace-c": "cat-12",
    });
  });

  it("maps a token onto the theme variable used by the sidebar", () => {
    expect(workspaceColorCssVar("cat-4")).toBe("var(--fd-cat-4)");
    expect(workspaceColorCssVar("nope")).toBeUndefined();
  });
});

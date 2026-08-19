import { describe, expect, it } from "vitest";

import {
  MAX_STARRED_MODELS,
  parseStarredModelIds,
  sortModelsByStarred,
  toggleStarredModelId,
} from "./starred-models";

describe("parseStarredModelIds", () => {
  it("returns an empty list for missing or invalid input", () => {
    expect(parseStarredModelIds(null)).toEqual([]);
    expect(parseStarredModelIds("")).toEqual([]);
    expect(parseStarredModelIds("{")).toEqual([]);
    expect(parseStarredModelIds('{"id":"gpt"}')).toEqual([]);
  });

  it("keeps order, trims, and drops blanks and duplicates", () => {
    expect(
      parseStarredModelIds('["gpt-5.6-sol", " ", "gpt-5.6", "gpt-5.6-sol", ""]'),
    ).toEqual(["gpt-5.6-sol", "gpt-5.6"]);
  });
});

describe("toggleStarredModelId", () => {
  it("prepends a new star and removes an existing one", () => {
    expect(toggleStarredModelId(["gpt-5.6"], "gpt-5.6-sol")).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6",
    ]);
    expect(toggleStarredModelId(["gpt-5.6-sol", "gpt-5.6"], "gpt-5.6-sol")).toEqual(
      ["gpt-5.6"],
    );
  });

  it("caps the stored list so starring cannot grow without bound", () => {
    const filled = Array.from({ length: MAX_STARRED_MODELS }, (_, index) =>
      `model-${index}`,
    );
    const next = toggleStarredModelId(filled, "newest");
    expect(next[0]).toBe("newest");
    expect(next).toHaveLength(MAX_STARRED_MODELS);
    expect(next).not.toContain(`model-${MAX_STARRED_MODELS - 1}`);
  });
});

describe("sortModelsByStarred", () => {
  const models = [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
    { id: "c", label: "C" },
    { id: "d", label: "D" },
  ];

  it("leaves the advertised order alone when nothing is starred", () => {
    expect(sortModelsByStarred(models, [])).toEqual(models);
    expect(sortModelsByStarred(models, [])).not.toBe(models);
  });

  it("pins starred models to the top in starred order", () => {
    expect(
      sortModelsByStarred(models, ["c", "a"]).map((model) => model.id),
    ).toEqual(["c", "a", "b", "d"]);
  });

  it("ignores starred ids that are not in the current roster", () => {
    expect(
      sortModelsByStarred(models, ["missing", "d"]).map((model) => model.id),
    ).toEqual(["d", "a", "b", "c"]);
  });
});

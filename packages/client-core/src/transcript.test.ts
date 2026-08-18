import { describe, expect, it } from "vitest";

import { insertTranscript } from "./transcript";

describe("insertTranscript", () => {
  it("fills an empty draft without padding", () => {
    expect(insertTranscript("", " Hello there ")).toEqual({
      value: "Hello there",
      caret: 11,
    });
  });

  it("appends to an existing draft when no caret is known", () => {
    expect(insertTranscript("Fix the bug", "in the parser")).toEqual({
      value: "Fix the bug in the parser",
      caret: 25,
    });
  });

  it("inserts at the caret and parks the caret after the transcript", () => {
    const result = insertTranscript("Fix the parser", "obvious", {
      start: 8,
      end: 8,
    });

    expect(result.value).toBe("Fix the obvious parser");
    expect(result.value.slice(0, result.caret)).toBe("Fix the obvious");
  });

  it("replaces the selected range", () => {
    expect(
      insertTranscript("Fix the parser", "linter", { start: 8, end: 14 }),
    ).toEqual({ value: "Fix the linter", caret: 14 });
  });

  it("does not double the spacing that is already there", () => {
    expect(insertTranscript("Fix the \nparser", "obvious", {
      start: 8,
      end: 8,
    })).toEqual({ value: "Fix the obvious\nparser", caret: 15 });
  });

  it("leaves a blank transcript alone", () => {
    expect(insertTranscript("Draft", "   ", { start: 2, end: 2 })).toEqual({
      value: "Draft",
      caret: 2,
    });
  });

  it("survives a caret left past the end of a shrunken draft", () => {
    expect(insertTranscript("Hi", "there", { start: 40, end: 40 })).toEqual({
      value: "Hi there",
      caret: 8,
    });
  });
});

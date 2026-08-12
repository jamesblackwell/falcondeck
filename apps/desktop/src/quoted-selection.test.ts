import { describe, expect, it } from "vitest";

import { composePromptWithQuotedSelections } from "@falcondeck/chat-ui";

describe("composePromptWithQuotedSelections", () => {
  it("serializes excerpts as plain Markdown blockquotes before the draft", () => {
    expect(
      composePromptWithQuotedSelections("What should I change?", [
        { id: "one", text: "First line\nSecond line" },
        { id: "two", text: "Another excerpt" },
      ]),
    ).toBe(
      "> First line\n> Second line\n\n> Another excerpt\n\nWhat should I change?",
    );
  });

  it("supports sending a selected excerpt without an added comment", () => {
    expect(
      composePromptWithQuotedSelections("", [
        { id: "one", text: "Selected text" },
      ]),
    ).toBe("> Selected text");
  });

  it("normalizes CRLF excerpts without changing draft whitespace", () => {
    expect(
      composePromptWithQuotedSelections("  indented comment\n", [
        { id: "one", text: "first\r\nsecond\rthird" },
      ]),
    ).toBe("> first\n> second\n> third\n\n  indented comment\n");
  });

  it("preserves code indentation while removing surrounding line breaks", () => {
    expect(
      composePromptWithQuotedSelections("Explain this", [
        { id: "one", text: "\n    indented()\n        nested()\n" },
      ]),
    ).toBe(">     indented()\n>         nested()\n\nExplain this");
  });
});

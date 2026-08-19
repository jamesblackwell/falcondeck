import { describe, expect, it } from "vitest";

import {
  markdownToSpeechText,
  prepareReadAloudText,
  splitReadAloudText,
} from "./read-aloud";

describe("markdownToSpeechText", () => {
  it("keeps prose while replacing code and tables with spoken summaries", () => {
    expect(
      markdownToSpeechText("# Update\n\nUse this:\n\n```ts\nconst ok = true;\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |"),
    ).toBe(
      "Update Use this: You can view the relevant code in the conversation. You can view the relevant table in the conversation.",
    );
  });

  it("retains inline code and accessible image text", () => {
    expect(markdownToSpeechText("Set `enabled` to true. ![Settings screen](image.png)")).toBe(
      "Set enabled to true. Image: Settings screen.",
    );
  });

  it("keeps very long responses within the daemon speech limit", () => {
    const text = prepareReadAloudText("A".repeat(8_100));
    expect(Array.from(text)).toHaveLength(8_000);
    expect(text.endsWith("This response was shortened for Read Aloud.")).toBe(
      true,
    );
  });

  it("splits long speech on whitespace so later audio can be prefetched", () => {
    const chunks = splitReadAloudText(`Start ${"word ".repeat(200)}`);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 600)).toBe(true);
    expect(chunks.join(" ")).toContain("Start word word");
  });
});

import { describe, expect, it } from "vitest";

import { parseCompactThreadCommand } from "./thread-commands";

describe("parseCompactThreadCommand", () => {
  it("recognizes the standalone command", () => {
    expect(parseCompactThreadCommand(" /compact ")).toEqual({
      instructions: null,
    });
  });

  it("retains optional compaction guidance", () => {
    expect(
      parseCompactThreadCommand("/compact preserve the protocol decisions"),
    ).toEqual({ instructions: "preserve the protocol decisions" });
  });

  it("does not hijack ordinary prompts or longer command names", () => {
    expect(parseCompactThreadCommand("Please run /compact now")).toBeNull();
    expect(parseCompactThreadCommand("/compaction")).toBeNull();
    expect(parseCompactThreadCommand("/compact\nthen keep working")).toEqual({
      instructions: "then keep working",
    });
  });
});

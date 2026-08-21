import { describe, expect, it } from "vitest";

import { providerMark, providerMarkSlug } from "./provider-marks";

describe("providerMark", () => {
  it("maps built-in harness ids to vendor marks", () => {
    expect(providerMark("codex")?.title).toBe("OpenAI");
    expect(providerMark("claude")?.title).toBe("Claude");
    expect(providerMark("opencode")?.title).toBe("OpenCode");
    expect(providerMark("gemini")?.title).toBe("Gemini");
    expect(providerMark("agy")?.title).toBe("Gemini");
    expect(providerMark("antigravity")?.title).toBe("Gemini");
    expect(providerMark("pi")?.title).toBe("Pi");
  });

  it("accepts aliases, ACP prefixes, and mixed case", () => {
    expect(providerMark("OpenAI")?.title).toBe("OpenAI");
    expect(providerMark("claude-code")?.title).toBe("Claude");
    expect(providerMark("acp-opencode")?.title).toBe("OpenCode");
    expect(providerMark("ACP-Grok")?.title).toBe("Grok");
    expect(providerMark("acp-cursor")?.title).toBe("Cursor");
  });

  it("returns null for unknown providers", () => {
    expect(providerMark("unknown-agent")).toBeNull();
    expect(providerMark("")).toBeNull();
  });

  it("strips the acp- prefix for slug lookup", () => {
    expect(providerMarkSlug("acp-opencode")).toBe("opencode");
    expect(providerMarkSlug("codex")).toBe("codex");
  });
});

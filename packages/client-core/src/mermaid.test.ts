import { describe, expect, it } from "vitest";

import {
  fenceLanguageFromClassName,
  isMermaidLanguage,
  mermaidRenderOptions,
  mermaidThemeVariables,
  type MermaidPalette,
} from "./mermaid";

const palette: MermaidPalette = {
  darkMode: true,
  fontFamily: "Geist, sans-serif",
  background: "#111113",
  surface: "#1a1a1f",
  surfaceRaised: "#232329",
  surfaceHighest: "#2c2c34",
  text: "#f4f4f6",
  textSecondary: "#c4c4cc",
  textMuted: "#84848f",
  border: "#2c2c34",
  borderSubtle: "#1a1a1f",
  accent: "#34d399",
  danger: "#f87171",
  cat: ["#f87171", "#fb923c", "#fbbf24"],
};

describe("isMermaidLanguage", () => {
  it("accepts mermaid fence tags regardless of case or padding", () => {
    expect(isMermaidLanguage("mermaid")).toBe(true);
    expect(isMermaidLanguage("MERMAID")).toBe(true);
    expect(isMermaidLanguage(" mmd ")).toBe(true);
  });

  it("rejects missing or unrelated fence tags", () => {
    expect(isMermaidLanguage(null)).toBe(false);
    expect(isMermaidLanguage(undefined)).toBe(false);
    expect(isMermaidLanguage("")).toBe(false);
    expect(isMermaidLanguage("bash")).toBe(false);
  });
});

describe("fenceLanguageFromClassName", () => {
  it("reads a language tag from a string or class list", () => {
    expect(fenceLanguageFromClassName("language-mermaid")).toBe("mermaid");
    expect(fenceLanguageFromClassName(["language-mermaid"])).toBe("mermaid");
    expect(fenceLanguageFromClassName(["hljs", "language-mmd"])).toBe("mmd");
  });

  it("ignores missing or unrelated class names", () => {
    expect(fenceLanguageFromClassName(undefined)).toBeNull();
    expect(fenceLanguageFromClassName("not-a-fence")).toBeNull();
    expect(fenceLanguageFromClassName({ language: "mermaid" })).toBeNull();
  });
});

describe("mermaidThemeVariables", () => {
  it("maps palette tokens onto mermaid's base theme", () => {
    const variables = mermaidThemeVariables(palette);
    expect(variables.darkMode).toBe(true);
    expect(variables.background).toBe("#111113");
    expect(variables.primaryTextColor).toBe("#f4f4f6");
    expect(variables.cScale0).toBe("#f87171");
    expect(variables.pie2).toBe("#fb923c");
  });

  it("omits empty colors so mermaid keeps its own fallbacks", () => {
    const variables = mermaidThemeVariables({
      ...palette,
      background: "",
      cat: ["", "#fb923c"],
    });
    expect(variables.background).toBeUndefined();
    expect(variables.cScale0).toBeUndefined();
    expect(variables.pie2).toBe("#fb923c");
  });
});

describe("mermaidRenderOptions", () => {
  it("locks down agent-authored diagrams", () => {
    const options = mermaidRenderOptions(palette);
    expect(options.securityLevel).toBe("strict");
    expect(options.startOnLoad).toBe(false);
    expect(options.htmlLabels).toBe(false);
    expect(options.look).toBe("classic");
    expect(options.flowchart.htmlLabels).toBe(false);
    expect(options.fontFamily).toBe(palette.fontFamily);
  });

  it("drops an empty font family rather than sending a blank string", () => {
    expect(mermaidRenderOptions({ ...palette, fontFamily: "" }).fontFamily)
      .toBeUndefined();
  });
});

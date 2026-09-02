import { describe, expect, it } from "vitest";

import {
  buildMermaidDocument,
  inlineMermaidScript,
  safeJsonForInlineScript,
  parseMermaidWebViewMessage,
} from "./mermaidHtml";
import { mermaidPaletteFromTheme } from "./mermaidPalette";

const palette = mermaidPaletteFromTheme({
  isDark: true,
  colors: {
    surface: { 1: "#111113", 2: "#1a1a1f", 3: "#232329", 4: "#2c2c34" },
    fg: { primary: "#f4f4f6", secondary: "#c4c4cc", muted: "#84848f" },
    border: { default: "#232329", subtle: "#1a1a1f" },
    accent: { default: "#34d399" },
    danger: { default: "#f87171" },
    cat: { 1: "#f87171", 2: "#fb923c" },
  },
  fontFamily: { sans: "Geist" },
});

describe("inlineMermaidScript", () => {
  it("escapes a closing script tag so the bundle cannot break out of the document", () => {
    expect(inlineMermaidScript("foo</script>bar")).toBe("foo<\\/script>bar");
    expect(inlineMermaidScript("foo</SCRIPT>bar")).toBe("foo<\\/SCRIPT>bar");
  });
});

describe("safeJsonForInlineScript", () => {
  it("cannot terminate the script element or inject Unicode line separators", () => {
    const encoded = safeJsonForInlineScript("</script><script>pwn()</script>\u2028\u2029");
    expect(encoded).not.toContain("<");
    expect(encoded).not.toContain("\u2028");
    expect(encoded).not.toContain("\u2029");
    expect(encoded).toContain("\\u003c/script>");
    expect(encoded).toContain("\\u2028\\u2029");
  });
});

describe("parseMermaidWebViewMessage", () => {
  it("reads a ready height and clamps empty heights", () => {
    expect(parseMermaidWebViewMessage('{"type":"ready","height":240}')).toEqual({
      type: "ready",
      height: 240,
    });
    expect(parseMermaidWebViewMessage('{"type":"ready","height":0}')).toEqual({
      type: "ready",
      height: 1,
    });
  });

  it("reads render errors and ignores malformed payloads", () => {
    expect(parseMermaidWebViewMessage('{"type":"error","message":"nope"}')).toEqual({
      type: "error",
      message: "nope",
    });
    expect(parseMermaidWebViewMessage('{"type":"error"}')).toEqual({
      type: "error",
      message: "Could not render diagram",
    });
    expect(parseMermaidWebViewMessage("not-json")).toBeNull();
    expect(parseMermaidWebViewMessage("null")).toBeNull();
    expect(parseMermaidWebViewMessage('{"type":"other"}')).toBeNull();
  });
});

describe("buildMermaidDocument", () => {
  it("embeds the source, theme, and mermaid engine", () => {
    const html = buildMermaidDocument({
      source: "flowchart TD\n  A-->B",
      mermaidScript: "window.mermaid = {};</script>",
      palette,
    });
    expect(html).toContain("flowchart TD");
    expect(html).toContain("securityLevel");
    expect(html).toContain("strict");
    expect(html).toContain("window.mermaid = {};<\\/script>");
    expect(html).toContain("#111113");
  });
});

describe("mermaidPaletteFromTheme", () => {
  it("maps object cat tokens and array palettes", () => {
    expect(palette.cat[0]).toBe("#f87171");
    expect(
      mermaidPaletteFromTheme({
        isDark: false,
        colors: {
          surface: { 1: "#fff", 2: "#eee", 3: "#ddd", 4: "#ccc" },
          fg: { primary: "#111", secondary: "#333", muted: "#666" },
          border: { default: "#ccc", subtle: "#eee" },
          accent: { default: "#0a0" },
          danger: { default: "#a00" },
          cat: ["#111", "#222"],
        },
        fontFamily: { sans: "Geist" },
      }).darkMode,
    ).toBe(false);
  });

  it("treats a missing isDark flag as dark and skips a missing cat scale", () => {
    const next = mermaidPaletteFromTheme({
      colors: {
        surface: { 1: "#111", 2: "#222", 3: "#333", 4: "#444" },
        fg: { primary: "#fff", secondary: "#ccc", muted: "#666" },
        border: { default: "#222", subtle: "#111" },
        accent: { default: "#0f0" },
        danger: { default: "#f00" },
      },
      fontFamily: { sans: "Geist" },
    });
    expect(next.darkMode).toBe(true);
    expect(next.cat.every((value) => value === "")).toBe(true);
  });
});

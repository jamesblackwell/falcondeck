import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  COLOR_THEME_OPTIONS,
  DARK_COLOR_THEME_OPTIONS,
  LIGHT_COLOR_THEME_OPTIONS,
  normalizeAppearance,
  type ColorThemeOption,
} from "@falcondeck/ui";

/**
 * A theme is only real once its option and matching CSS block agree. Related
 * light and dark themes can share one data-palette selector, while standalone
 * themes such as Matrix intentionally ship in only one appearance.
 */
// jsdom hands import.meta.url an http URL, so resolve from the workspace root.
const STYLES = readFileSync(
  resolve(process.cwd(), "../../packages/ui/src/styles.css"),
  "utf8",
);

function tokensFor(selector: string): Record<string, string> {
  const start = STYLES.indexOf(`${selector} {`);
  if (start === -1) return {};
  const block = STYLES.slice(start, STYLES.indexOf("}", start));
  const tokens: Record<string, string> = {};
  for (const [, name, value] of block.matchAll(/(--fd-[\w-]+):\s*([^;]+);/g)) {
    tokens[name] = value.trim();
  }
  return tokens;
}

function selectorFor(option: ColorThemeOption) {
  if (option.palette === "falcon") {
    return option.appearance === "light" ? ':root[data-theme="light"]' : ":root";
  }
  const paletteSelector = `:root[data-palette="${option.palette}"]`;
  return option.appearance === "light"
    ? `${paletteSelector}[data-theme="light"]`
    : paletteSelector;
}

function relativeLuminance(hex: string): number {
  const channels = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) =>
      channel <= 0.04045
        ? channel / 12.92
        : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe("color palettes", () => {
  it("ships a CSS block matching every theme's declared appearance", () => {
    for (const option of COLOR_THEME_OPTIONS) {
      expect(Object.keys(tokensFor(selectorFor(option))).length, option.value).toBeGreaterThan(0);
    }
  });

  it("previews the tokens the theme actually applies", () => {
    for (const option of COLOR_THEME_OPTIONS) {
      const tokens = tokensFor(selectorFor(option));
      expect(option.preview).toEqual({
        bg: tokens["--fd-bg-1"],
        surface: tokens["--fd-bg-2"],
        fg: tokens["--fd-fg-0"],
        accent: tokens["--fd-accent"],
      });
    }
  });

  it("keeps every theme distinguishable within its picker", () => {
    for (const options of [LIGHT_COLOR_THEME_OPTIONS, DARK_COLOR_THEME_OPTIONS]) {
      const swatches = options.map((option) => Object.values(option.preview).join("/"));
      expect(new Set(swatches).size).toBe(swatches.length);
    }
  });

  it("keeps copy and decorative foregrounds above their documented contrast floors", () => {
    for (const option of COLOR_THEME_OPTIONS) {
      const tokens = tokensFor(selectorFor(option));
      for (const foreground of ["--fd-fg-0", "--fd-fg-1", "--fd-fg-2", "--fd-fg-3"]) {
        expect(
          contrastRatio(tokens[foreground], tokens["--fd-bg-1"]),
          `${option.value} ${foreground}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      expect(
        contrastRatio(tokens["--fd-fg-4"], tokens["--fd-bg-1"]),
        `${option.value} --fd-fg-4`,
      ).toBeGreaterThanOrEqual(3);
    }
  });

  it("keeps Matrix dark-only", () => {
    expect(DARK_COLOR_THEME_OPTIONS.some((option) => option.value === "matrix")).toBe(true);
    expect(LIGHT_COLOR_THEME_OPTIONS.some((option) => option.palette === "matrix")).toBe(false);
  });

  it("migrates a legacy palette into independent light and dark preferences", () => {
    expect(normalizeAppearance({ theme: "system", palette: "dracula" })).toMatchObject({
      theme: "system",
      lightColorTheme: "alucard",
      darkColorTheme: "dracula",
    });
  });

  it("keeps typed font names CSS-safe and clamps surface tweaks", () => {
    expect(
      normalizeAppearance({
        sansFont: "custom",
        sansFontCustom: 'Lexend"; } body { url(evil)',
        chatFont: "serif",
        chatScale: 9,
        codeScale: 0.1,
        sidebarWeight: 437,
        uiWeight: -20,
      }),
    ).toMatchObject({
      sansFont: "custom",
      sansFontCustom: "Lexend  body  urlevil",
      chatFont: "serif",
      chatScale: 1.3,
      codeScale: 0.8,
      sidebarWeight: 450,
      uiWeight: 0,
    });
  });

  it("defaults unknown font choices and leaves chat matching the interface", () => {
    expect(normalizeAppearance({ sansFont: "comic-sans", chatFont: "wide" })).toMatchObject({
      sansFont: "geist",
      chatFont: "match",
      sidebarScale: 1,
      chatWeight: 0,
    });
  });
});

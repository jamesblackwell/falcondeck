import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { PALETTE_OPTIONS } from "@falcondeck/ui";

/**
 * A palette is only real once it exists in three places: the option list, a
 * dark CSS block, and a light one. The swatch in the picker is drawn from the
 * option's `preview`, so these tests also pin that quartet to the tokens it
 * claims to show — a chip that lies about the theme is worse than no chip.
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

function selectorsFor(palette: string) {
  return palette === "falcon"
    ? { dark: ":root", light: ':root[data-theme="light"]' }
    : {
        dark: `:root[data-palette="${palette}"]`,
        light: `:root[data-palette="${palette}"][data-theme="light"]`,
      };
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
  it("ships a dark and a light CSS block for every option", () => {
    for (const option of PALETTE_OPTIONS) {
      const { dark, light } = selectorsFor(option.value);
      expect(Object.keys(tokensFor(dark)).length, `${option.value} dark`).toBeGreaterThan(0);
      expect(Object.keys(tokensFor(light)).length, `${option.value} light`).toBeGreaterThan(0);
    }
  });

  it("previews the tokens the palette actually applies", () => {
    for (const option of PALETTE_OPTIONS) {
      const selectors = selectorsFor(option.value);
      for (const mode of ["dark", "light"] as const) {
        // Light blocks only override what changes, so fall back to the dark
        // block the same way the cascade does.
        const tokens = { ...tokensFor(selectors.dark), ...tokensFor(selectors[mode]) };
        expect({ mode, ...option.preview[mode] }).toEqual({
          mode,
          bg: tokens["--fd-bg-1"],
          surface: tokens["--fd-bg-2"],
          fg: tokens["--fd-fg-0"],
          accent: tokens["--fd-accent"],
        });
      }
    }
  });

  it("keeps every palette distinguishable in the picker", () => {
    for (const mode of ["dark", "light"] as const) {
      const swatches = PALETTE_OPTIONS.map((option) =>
        Object.values(option.preview[mode]).join("/"),
      );
      expect(new Set(swatches).size).toBe(swatches.length);
    }
  });

  it("keeps copy and decorative foregrounds above their documented contrast floors", () => {
    for (const option of PALETTE_OPTIONS) {
      const selectors = selectorsFor(option.value);
      for (const mode of ["dark", "light"] as const) {
        const tokens = { ...tokensFor(selectors.dark), ...tokensFor(selectors[mode]) };
        for (const foreground of ["--fd-fg-0", "--fd-fg-1", "--fd-fg-2", "--fd-fg-3"]) {
          expect(
            contrastRatio(tokens[foreground], tokens["--fd-bg-1"]),
            `${option.value} ${mode} ${foreground}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
        expect(
          contrastRatio(tokens["--fd-fg-4"], tokens["--fd-bg-1"]),
          `${option.value} ${mode} --fd-fg-4`,
        ).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

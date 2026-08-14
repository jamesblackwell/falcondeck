import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const STYLES = readFileSync(
  resolve(process.cwd(), "../../packages/ui/src/styles.css"),
  "utf8",
);

describe("typography system", () => {
  it("maps concise Tailwind utilities to the scalable FalconDeck tokens", () => {
    for (const size of ["2xs", "xs", "sm", "base", "md", "lg", "xl", "2xl", "3xl"]) {
      expect(STYLES).toContain(`--text-${size}: var(--fd-text-${size});`);
      expect(STYLES).toContain(`--text-${size}--line-height: var(--fd-leading-`);
    }
    for (const leading of ["tight", "normal", "relaxed"]) {
      expect(STYLES).toContain(`--leading-${leading}: var(--fd-leading-${leading});`);
    }
    for (const tracking of ["tight", "normal", "wide", "widest"]) {
      expect(STYLES).toContain(`--tracking-${tracking}: var(--fd-tracking-${tracking});`);
    }
  });

  it("defines the shared semantic typography roles", () => {
    for (const role of ["body", "supporting", "label", "meta", "heading", "microlabel"]) {
      expect(STYLES).toContain(`.fd-type-${role}`);
    }
  });
});

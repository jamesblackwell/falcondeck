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
    for (const role of [
      "body",
      "supporting",
      "label",
      "meta",
      "heading",
      "microlabel",
      "eyebrow",
    ]) {
      expect(STYLES).toContain(`.fd-type-${role}`);
    }
  });

  it("rations monospace in Activity to the terminal readouts", () => {
    const activity = readFileSync(
      resolve(
        process.cwd(),
        "../../packages/chat-ui/src/components/activity-view.tsx",
      ),
      "utf8",
    );

    // Activity shows a dozen threads at once, so it is the view most tempted
    // to set its whole chrome in monospace — which is what made it read as a
    // different application. Section headings, stat labels, host badges, and
    // timestamps belong to the same voice as the rest of the UI; a monospace
    // face is reserved for text the machine actually wrote.
    for (const adHoc of ["font-mono", "fd-readout", "fd-microlabel"]) {
      expect(activity).not.toContain(adHoc);
    }
    // The readout lines, its empty state, and the ❯ sigil. Nothing else.
    expect(activity.match(/fd-type-mono/g) ?? []).toHaveLength(3);
  });
});

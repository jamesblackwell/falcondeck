import { describe, expect, it } from "vitest";

import {
  safeArtifactFilename,
  safeArtifactMimeType,
} from "./artifact-presentation";

describe("artifact presentation safety", () => {
  it("normalizes provider filenames into portable leaf names", () => {
    expect(safeArtifactFilename("../../Quarterly report?.pdf")).toBe(
      "Quarterly-report-.pdf",
    );
    expect(safeArtifactFilename("../..")).toBe("artifact");
    expect(safeArtifactFilename("CON.txt")).toBe("_CON.txt");
    expect(safeArtifactFilename("release.json. ")).toBe("release.json");
  });

  it("bounds filenames by Unicode code point without splitting characters", () => {
    const safe = safeArtifactFilename(`${"a".repeat(119)}🚀.txt`);
    expect(Array.from(safe)).toHaveLength(120);
    expect(safe.endsWith("-")).toBe(true);
    expect(safe).not.toContain("\uFFFD");
  });

  it("accepts bare media types and rejects provider-authored parameters", () => {
    expect(safeArtifactMimeType(" Application/JSON ")).toBe(
      "application/json",
    );
    expect(safeArtifactMimeType("image/svg+xml")).toBe("image/svg+xml");
    expect(safeArtifactMimeType("text/plain; charset=utf-8")).toBeNull();
    expect(
      safeArtifactMimeType("text/html\r\nContent-Disposition: inline"),
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";

import scratchPad from "../../../extensions/official/scratch-pad/server";

import { createExtensionTestHost } from "./index";

describe("Scratch pad public backend SDK contract", () => {
  it("saves and reads a single Markdown document", async () => {
    const host = createExtensionTestHost(scratchPad, {
      extensionId: "falcondeck.scratch-pad",
      declaredActions: ["notes"],
      declaredViews: ["scratch-pad"],
    });

    const saved = await host.invokeAction("notes", {
      input: {
        operation: "save",
        body: "# Meeting\n\nAsk about the release.",
      },
    });

    expect(saved.storage.pad).toBe("# Meeting\n\nAsk about the release.");
    expect(JSON.stringify(saved.publishedViews)).toContain("Meeting");

    const listed = await host.invokeAction("notes", {
      input: { operation: "read" },
    });
    expect(listed.result).toEqual({
      body: "# Meeting\n\nAsk about the release.",
    });
  });

  it("migrates the newest legacy note into the single pad", async () => {
    const host = createExtensionTestHost(scratchPad, {
      extensionId: "falcondeck.scratch-pad",
      declaredActions: ["notes"],
      declaredViews: ["scratch-pad"],
      storage: {
        notes: [
          {
            id: "note-1",
            body: "Older",
            createdAt: "2026-08-19T08:00:00.000Z",
            updatedAt: "2026-08-19T08:00:00.000Z",
          },
          {
            id: "note-2",
            body: "Keep this",
            createdAt: "2026-08-19T09:00:00.000Z",
            updatedAt: "2026-08-19T09:00:00.000Z",
          },
        ],
      },
    });

    const result = await host.invokeAction("notes", {
      input: { operation: "read" },
    });

    expect(result.result).toEqual({ body: "Keep this" });
    expect(result.storage.pad).toBe("Keep this");
    expect(result.storage.notes).toBeUndefined();
  });

  it("rejects an oversized note body", async () => {
    const host = createExtensionTestHost(scratchPad, {
      extensionId: "falcondeck.scratch-pad",
      declaredActions: ["notes"],
      declaredViews: ["scratch-pad"],
    });

    await expect(
      host.invokeAction("notes", {
        input: { operation: "save", body: "n".repeat(8_001) },
      }),
    ).rejects.toThrow("note is too long");
    expect(host.storageSnapshot()).toEqual({});
  });
});

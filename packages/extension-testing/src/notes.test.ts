import { describe, expect, it } from "vitest";

import notes from "../../../extensions/official/notes/server";

import { createExtensionTestHost } from "./index";

type ListedNote = { id: string; title: string; body: string };

function host(storage?: Record<string, unknown>) {
  return createExtensionTestHost(notes, {
    extensionId: "falcondeck.notes",
    declaredActions: ["notes"],
    declaredViews: ["notes"],
    storage,
  });
}

function listed(result: unknown): ListedNote[] {
  return (result as { notes: ListedNote[] }).notes;
}

describe("Notes public backend SDK contract", () => {
  it("creates, edits, and lists several notes", async () => {
    const testHost = host();

    const created = await testHost.invokeAction("notes", {
      input: { operation: "create" },
    });
    const [note] = listed(created.result);
    expect(note!.title).toBe("New note");

    const saved = await testHost.invokeAction("notes", {
      input: {
        operation: "save",
        id: note!.id,
        body: "# Meeting\n\nAsk about the release.",
      },
    });
    expect(listed(saved.result)[0]!.title).toBe("Meeting");
    expect(JSON.stringify(saved.publishedViews)).toContain("Meeting");

    await testHost.invokeAction("notes", {
      input: { operation: "create", body: "Groceries" },
    });
    const all = listed(
      (await testHost.invokeAction("notes", { input: { operation: "read" } }))
        .result,
    );
    expect(all.map((entry) => entry.title).sort()).toEqual([
      "Groceries",
      "Meeting",
    ]);
  });

  it("deletes a note and leaves the rest alone", async () => {
    const testHost = host();
    await testHost.invokeAction("notes", {
      input: { operation: "create", body: "Keep" },
    });
    const second = listed(
      (
        await testHost.invokeAction("notes", {
          input: { operation: "create", body: "Discard" },
        })
      ).result,
    ).find((entry) => entry.body === "Discard")!;

    const remaining = listed(
      (
        await testHost.invokeAction("notes", {
          input: { operation: "delete", id: second.id },
        })
      ).result,
    );
    expect(remaining.map((entry) => entry.body)).toEqual(["Keep"]);
  });

  it("migrates the single Scratch pad document into a note", async () => {
    const testHost = host({ pad: "# Meeting\n\nAsk about the release." });

    const result = await testHost.invokeAction("notes", {
      input: { operation: "read" },
    });

    const all = listed(result.result);
    expect(all).toHaveLength(1);
    expect(all[0]!.body).toBe("# Meeting\n\nAsk about the release.");
    expect(all[0]!.title).toBe("Meeting");
    expect(result.storage.pad).toBeUndefined();
    expect(result.storage.library).toHaveLength(1);
  });

  it("migrates pre-pad legacy notes", async () => {
    const testHost = host({
      notes: [
        {
          id: "note-1",
          body: "Older",
          createdAt: "2026-08-19T08:00:00.000Z",
          updatedAt: "2026-08-19T08:00:00.000Z",
        },
        {
          id: "note-2",
          body: "Newer",
          createdAt: "2026-08-19T09:00:00.000Z",
          updatedAt: "2026-08-19T09:00:00.000Z",
        },
      ],
    });

    const result = await testHost.invokeAction("notes", {
      input: { operation: "read" },
    });

    expect(listed(result.result).map((entry) => entry.body)).toEqual([
      "Newer",
      "Older",
    ]);
    expect(result.storage.notes).toBeUndefined();
  });

  it("rejects an oversized note body", async () => {
    const testHost = host();
    const note = listed(
      (await testHost.invokeAction("notes", { input: { operation: "create" } }))
        .result,
    )[0]!;

    await expect(
      testHost.invokeAction("notes", {
        input: { operation: "save", id: note.id, body: "n".repeat(8_001) },
      }),
    ).rejects.toThrow("note is too long");
  });

  it("rejects saving an unknown note", async () => {
    const testHost = host();
    await expect(
      testHost.invokeAction("notes", {
        input: { operation: "save", id: "note-9", body: "ghost" },
      }),
    ).rejects.toThrow("note not found");
    expect(testHost.storageSnapshot()).toEqual({});
  });

  it("serializes concurrent creates so neither update is lost", async () => {
    const testHost = host();
    await testHost.invokeAction("notes", { input: { operation: "read" } });

    await Promise.all([
      testHost.invokeAction("notes", {
        input: { operation: "create", body: "First" },
      }),
      testHost.invokeAction("notes", {
        input: { operation: "create", body: "Second" },
      }),
    ]);

    const all = listed(
      (await testHost.invokeAction("notes", { input: { operation: "read" } }))
        .result,
    );
    expect(all.map((note) => note.body).sort()).toEqual(["First", "Second"]);
  });

  it("never reuses the identifier of a deleted note", async () => {
    const testHost = host();
    const deleted = listed(
      await testHost.invokeAction("notes", {
        input: { operation: "create", body: "Delete me" },
      }).then((result) => result.result),
    )[0]!;
    await testHost.invokeAction("notes", {
      input: { operation: "delete", id: deleted.id },
    });
    const replacement = listed(
      await testHost.invokeAction("notes", {
        input: { operation: "create", body: "Replacement" },
      }).then((result) => result.result),
    )[0]!;

    expect(replacement.id).not.toBe(deleted.id);
  });
});

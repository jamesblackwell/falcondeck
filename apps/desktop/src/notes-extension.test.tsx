import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { collectExtensionApp } from "@falcondeck/extension-sdk/app";

import notesApp from "../../../extensions/official/notes/app";

type StoredNote = {
  id: string;
  title: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

function note(id: string, body: string, title: string): StoredNote {
  return {
    id,
    title,
    body,
    createdAt: "2026-08-20T09:00:00.000Z",
    updatedAt: "2026-08-20T09:00:00.000Z",
  };
}

/** A minimal stand-in for the daemon-backed `notes` action. */
function libraryStub(initial: StoredNote[]) {
  let notes = [...initial];
  return vi.fn(async (_actionId: string, input?: unknown) => {
    const request = input as {
      operation: string;
      id?: string;
      body?: string;
    };
    if (request.operation === "create") {
      notes = [
        note(`note-${notes.length + 1}`, request.body ?? "", "New note"),
        ...notes,
      ];
    } else if (request.operation === "save") {
      notes = notes.map((entry) =>
        entry.id === request.id
          ? { ...entry, body: request.body ?? "", title: request.body ?? "" }
          : entry,
      );
    } else if (request.operation === "delete") {
      notes = notes.filter((entry) => entry.id !== request.id);
    }
    return { result: { notes }, updatedViews: [] };
  });
}

function renderNotes(invokeAction: ReturnType<typeof libraryStub>) {
  const Component = collectExtensionApp(notesApp).panels[0]!.component;
  render(
    <Component
      extensionId="falcondeck.notes"
      threads={[]}
      views={[]}
      hasPermission={() => false}
      invokeAction={invokeAction}
      openThread={vi.fn()}
    />,
  );
}

describe("Notes trusted frontend", () => {
  it("registers a Notes panel", () => {
    const registration = collectExtensionApp(notesApp);
    expect(registration.extensionId).toBe("falcondeck.notes");
    expect(registration.panels[0]!.title).toBe("Notes");
  });

  it("lists notes, switches between them, and autosaves edits", async () => {
    const invokeAction = libraryStub([
      note("note-1", "# Meeting\n\nAsk about the release.", "Meeting"),
      note("note-2", "Groceries", "Groceries"),
    ]);
    renderNotes(invokeAction);

    const editor = await screen.findByRole("textbox", { name: "Note" });
    expect(editor).toHaveValue("# Meeting\n\nAsk about the release.");

    fireEvent.click(await screen.findByRole("button", { name: /^Groceries/ }));
    await waitFor(() => expect(editor).toHaveValue("Groceries"));

    fireEvent.change(editor, { target: { value: "Groceries and milk" } });
    await waitFor(() =>
      expect(invokeAction).toHaveBeenCalledWith("notes", {
        operation: "save",
        id: "note-2",
        body: "Groceries and milk",
      }),
    );
  });

  it("creates a note and focuses the empty editor", async () => {
    const invokeAction = libraryStub([note("note-1", "Meeting", "Meeting")]);
    renderNotes(invokeAction);

    await screen.findByRole("textbox", { name: "Note" });
    fireEvent.click(screen.getByRole("button", { name: "New note" }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Note" })).toHaveValue(""),
    );
    expect(invokeAction).toHaveBeenCalledWith("notes", {
      operation: "create",
    });
  });

  it("deletes a note and selects what remains", async () => {
    const invokeAction = libraryStub([
      note("note-1", "Meeting", "Meeting"),
      note("note-2", "Groceries", "Groceries"),
    ]);
    renderNotes(invokeAction);

    await screen.findByRole("textbox", { name: "Note" });
    fireEvent.click(screen.getByRole("button", { name: "Delete Meeting" }));

    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Note" })).toHaveValue(
        "Groceries",
      ),
    );
    expect(
      screen.queryByRole("button", { name: /^Meeting/ }),
    ).not.toBeInTheDocument();
  });

  it("filters the list by search text", async () => {
    const invokeAction = libraryStub([
      note("note-1", "Meeting", "Meeting"),
      note("note-2", "Groceries", "Groceries"),
    ]);
    renderNotes(invokeAction);

    await screen.findByRole("textbox", { name: "Note" });
    fireEvent.change(screen.getByRole("textbox", { name: "Search notes" }), {
      target: { value: "groc" },
    });

    expect(screen.getByRole("button", { name: /^Groceries/ })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^Meeting/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps line breaks in Markdown preview", async () => {
    const invokeAction = libraryStub([
      note("note-1", "Test\nthis is quite cool", "Test"),
    ]);
    renderNotes(invokeAction);

    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    const preview = await within(
      screen.getByLabelText("Note preview"),
    ).findByText(/this is quite cool/);
    expect(preview.textContent).toBe("Test\nthis is quite cool");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("offers an empty state when there are no notes", async () => {
    const invokeAction = libraryStub([]);
    renderNotes(invokeAction);

    expect(await screen.findByText("No notes yet.")).toBeVisible();
    fireEvent.click(
      screen.getAllByRole("button", { name: "New note" }).at(-1)!,
    );
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Note" })).toBeVisible(),
    );
  });
});

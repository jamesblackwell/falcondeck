import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  LocalPathLink,
  LocalPathProvider,
  type LocalPathEditor,
  type LocalPathKindResolver,
} from "./local-path-context";

const FILE = "/Users/qa/notes.md";

function renderPathMenu(
  handler: (action: string, path: string, editorId?: string) => void,
  options: {
    editors?: readonly LocalPathEditor[];
    describePath?: LocalPathKindResolver | null;
  } = {},
) {
  return render(
    <LocalPathProvider
      onLocalPath={handler}
      editors={options.editors ?? []}
      describePath={options.describePath ?? null}
    >
      <LocalPathLink path={FILE}>notes.md</LocalPathLink>
    </LocalPathProvider>,
  );
}

function openContextMenu() {
  fireEvent.contextMenu(screen.getByRole("link", { name: `Open ${FILE}` }));
}

describe("LocalPathProvider menu", () => {
  it("offers detected editors as open-with actions", () => {
    const handler = vi.fn();
    renderPathMenu(handler, {
      editors: [
        { id: "zed", name: "Zed" },
        { id: "vscode", name: "VS Code" },
      ],
    });

    openContextMenu();
    expect(
      screen.getByRole("menuitem", { name: "Open in Zed" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Open in VS Code" }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "Open in Zed" }));
    expect(handler).toHaveBeenCalledWith("open-with", FILE, "zed");
  });

  it("offers save and copy-contents actions for files", async () => {
    const handler = vi.fn();
    renderPathMenu(handler, {
      describePath: () => Promise.resolve("file"),
    });

    openContextMenu();
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "Save As…" })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Save As…" }));
    expect(handler).toHaveBeenCalledWith("save-as", FILE);

    openContextMenu();
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: "Copy File Contents" })).toBeInTheDocument();
    });
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Copy File Contents" }),
    );
    expect(handler).toHaveBeenCalledWith("copy-contents", FILE);
  });

  it("hides file-only actions once the path is known to be a directory", async () => {
    const handler = vi.fn();
    renderPathMenu(handler, {
      describePath: () => Promise.resolve("directory"),
    });

    openContextMenu();
    await waitFor(() => {
      expect(screen.queryByRole("menuitem", { name: "Save As…" })).toBeNull();
    });
    expect(
      screen.queryByRole("menuitem", { name: "Copy File Contents" }),
    ).toBeNull();
    // Directory actions stay available.
    expect(screen.getByRole("menuitem", { name: "Open" })).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Copy Path" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: /Reveal in Finder|Show in folder/ }),
    ).toBeInTheDocument();
  });

  it("withholds file-only actions when no host can confirm the path kind", () => {
    const handler = vi.fn();
    renderPathMenu(handler);

    openContextMenu();
    expect(screen.queryByRole("menuitem", { name: "Save As…" })).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "Copy File Contents" }),
    ).toBeNull();
  });

  it("keeps paths inert when no host handles them", () => {
    render(<LocalPathLink path={FILE}>notes.md</LocalPathLink>);

    expect(screen.queryByRole("link")).toBeNull();
    fireEvent.contextMenu(screen.getByText("notes.md"));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

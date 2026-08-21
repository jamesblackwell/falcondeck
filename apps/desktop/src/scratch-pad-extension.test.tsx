import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { collectExtensionApp } from "@falcondeck/extension-sdk/app";

import scratchPadApp from "../../../extensions/official/scratch-pad/app";

describe("Scratch pad trusted frontend", () => {
  it("loads the pad and autosaves edits through the public action", async () => {
    const registration = collectExtensionApp(scratchPadApp).panels[0]!;
    const Component = registration.component;
    const invokeAction = vi.fn(async (_actionId: string, input?: unknown) => {
      const operation = (input as { operation?: string } | undefined)?.operation;
      if (operation === "read") {
        return {
          result: { body: "# Meeting\n\nAsk about the release." },
          updatedViews: [],
        };
      }
      return {
        result: { body: (input as { body: string }).body },
        updatedViews: [],
      };
    });

    render(
      <Component
        extensionId="falcondeck.scratch-pad"
        threads={[]}
        views={[]}
        hasPermission={() => false}
        invokeAction={invokeAction}
        openThread={vi.fn()}
      />,
    );

    const editor = await screen.findByRole("textbox", { name: "Scratch pad" });
    expect(editor).toHaveValue("# Meeting\n\nAsk about the release.");
    fireEvent.change(editor, {
      target: { value: "# Meeting\n\nShip it." },
    });

    await waitFor(() =>
      expect(invokeAction).toHaveBeenCalledWith("notes", {
        operation: "save",
        body: "# Meeting\n\nShip it.",
      }),
    );
  });

  it("keeps line breaks in Markdown preview", async () => {
    const Component = collectExtensionApp(scratchPadApp).panels[0]!.component;
    render(
      <Component
        extensionId="falcondeck.scratch-pad"
        threads={[]}
        views={[]}
        hasPermission={() => false}
        invokeAction={vi.fn(async () => ({
          result: { body: "Test\nthis is quite cool" },
          updatedViews: [],
        }))}
        openThread={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Preview" }));
    const preview = await screen.findByText(/this is quite cool/);
    expect(preview.textContent).toBe("Test\nthis is quite cool");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

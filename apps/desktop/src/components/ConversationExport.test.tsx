import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Conversation } from "@falcondeck/chat-ui";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("conversation export", () => {
  it("downloads loaded conversation history with an honest partial label", () => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn(() => "blob:conversation-export");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    let clickedDownload: string | null = null;
    let clickedHref: string | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
      function captureAnchor(this: HTMLAnchorElement) {
        clickedDownload = this.download;
        clickedHref = this.href;
      },
    );

    render(
      <Conversation
        exportTitle="Release audit"
        hasOlder
        items={[
          {
            kind: "user_message",
            id: "user-1",
            text: "Run the checks.",
            attachments: [],
            created_at: "2026-08-10T12:00:00Z",
          },
        ]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Download loaded conversation as Markdown. Earlier messages are not loaded.",
      }),
    );
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(createObjectURL.mock.calls[0]?.[0]).toBeInstanceOf(Blob);
    expect(clickedDownload).toBe("Release-audit.md");
    expect(clickedHref).toBe("blob:conversation-export");
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:conversation-export");
  });

  it("keeps a preparation failure attached to the export action", () => {
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => {
        throw new Error("Unavailable");
      }),
      revokeObjectURL: vi.fn(),
    });
    render(
      <Conversation
        items={[
          {
            kind: "assistant_message",
            id: "assistant-1",
            text: "Finished.",
            created_at: "2026-08-10T12:00:00Z",
          },
        ]}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Download conversation as Markdown",
      }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not prepare this conversation download.",
    );
  });
});

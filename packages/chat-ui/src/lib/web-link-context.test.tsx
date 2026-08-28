import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WebLinkAnchor, WebLinkProvider } from "./web-link-context";

const URL = "https://example.com/guide";

function renderLinkMenu(onOpenLink: (url: string) => void) {
  return render(
    <WebLinkProvider onOpenLink={onOpenLink}>
      <WebLinkAnchor href={URL}>Example</WebLinkAnchor>
    </WebLinkProvider>,
  );
}

describe("WebLinkProvider menu", () => {
  it("opens the link through the host opener", () => {
    const onOpenLink = vi.fn();
    renderLinkMenu(onOpenLink);

    fireEvent.contextMenu(screen.getByRole("link", { name: "Example" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open Link" }));

    expect(onOpenLink).toHaveBeenCalledWith(URL);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("copies the link URL", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    renderLinkMenu(vi.fn());

    fireEvent.contextMenu(screen.getByRole("link", { name: "Example" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy Link" }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(URL));
  });

  it("renders a plain anchor when no host handles links", () => {
    render(<WebLinkAnchor href={URL}>Example</WebLinkAnchor>);

    const anchor = screen.getByRole("link", { name: "Example" });
    expect(anchor.getAttribute("target")).toBe("_blank");
    fireEvent.contextMenu(anchor);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

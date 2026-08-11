import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageCard } from "@falcondeck/chat-ui";
import type {
  ContentLifecycle,
  ConversationItem,
} from "@falcondeck/client-core";

function imageItem(
  lifecycle: ContentLifecycle,
  url = "https://example.com/falcon.png",
) {
  return {
    kind: "image",
    id: `image-${lifecycle}`,
    title: "Generated image",
    image: {
      id: `image-${lifecycle}-asset`,
      name: "falcon.png",
      mime_type: "image/png",
      url,
      local_path: null,
      alt_text: "A falcon over a control deck",
    },
    lifecycle,
    created_at: "2026-08-08T20:00:00Z",
  } satisfies Extract<ConversationItem, { kind: "image" }>;
}

describe("image output presentation", () => {
  it("previews a complete remote image in-app and keeps external opening explicit", async () => {
    render(<MessageCard item={imageItem("complete")} />);
    expect(
      screen.getByRole("img", { name: "A falcon over a control deck" }),
    ).toBeInTheDocument();
    const preview = screen.getByRole("button", {
      name: "Preview A falcon over a control deck",
    });
    expect(
      screen.getByRole("link", { name: "Open original image" }),
    ).toHaveAttribute("href", "https://example.com/falcon.png");

    fireEvent.click(preview);
    const dialog = screen.getByRole("dialog", {
      name: "Preview A falcon over a control deck",
    });
    expect(
      within(dialog).getByRole("img", { name: "A falcon over a control deck" }),
    ).toBeVisible();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Close image preview" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await waitFor(() => expect(preview).toHaveFocus());
  });

  it("previews safe inline images without inventing an external-open action", () => {
    render(
      <MessageCard
        item={imageItem("complete", "data:image/png;base64,AAAA")}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: "Preview A falcon over a control deck",
      }),
    );
    expect(
      screen.getByRole("dialog", {
        name: "Preview A falcon over a control deck",
      }),
    ).toBeVisible();
    expect(
      screen.queryByRole("link", { name: "Open original image" }),
    ).not.toBeInTheDocument();
  });

  it("turns a failed full-size decode into an explicit preview receipt", () => {
    render(<MessageCard item={imageItem("complete")} />);
    fireEvent.click(
      screen.getByRole("button", {
        name: "Preview A falcon over a control deck",
      }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Preview A falcon over a control deck",
    });
    fireEvent.error(within(dialog).getByRole("img"));

    expect(
      within(dialog).getByRole("img", {
        name: "A falcon over a control deck, image unavailable",
      }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Close image preview" }),
    ).toBeVisible();
  });

  it("shows a stable generating receipt before an asset arrives", () => {
    render(<MessageCard item={imageItem("streaming", "")} />);
    expect(
      screen.getByRole("figure", {
        name: "A falcon over a control deck, streaming",
      }),
    ).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Generating image…");
  });

  it("turns a failed network image into an explicit unavailable state", () => {
    render(<MessageCard item={imageItem("complete")} />);
    fireEvent.error(screen.getByRole("img"));
    const unavailable = screen.getByRole("status");
    expect(unavailable).toHaveTextContent("Image unavailable");
    expect(unavailable.parentElement).toHaveClass("min-h-24");
  });

  it("announces a provider image failure assertively without reserving a full canvas", () => {
    render(<MessageCard item={imageItem("error", "")} />);

    const unavailable = screen.getByRole("alert");
    expect(unavailable).toHaveTextContent("Image unavailable");
    expect(unavailable).toHaveAttribute("aria-live", "assertive");
    expect(unavailable.parentElement).toHaveClass("min-h-24");
    expect(unavailable.parentElement).not.toHaveClass("min-h-48");
  });

  it("never passes an executable provider URL to the image decoder", () => {
    render(<MessageCard item={imageItem("complete", "javascript:alert(1)")} />);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Preview/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open original image" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Image unavailable");
  });

  it("rejects credential-bearing remote images instead of exposing an original link", () => {
    render(
      <MessageCard
        item={imageItem(
          "complete",
          "https://user:secret@example.com/falcon.png",
        )}
      />,
    );

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Open original image" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Image unavailable");
  });

  it("preserves a usable image when the generation later reports an error", () => {
    render(<MessageCard item={imageItem("error")} />);
    expect(
      screen.getByRole("img", { name: "A falcon over a control deck" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeInTheDocument();
  });
});

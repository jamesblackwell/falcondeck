import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { MessageCard } from "@falcondeck/chat-ui";
import type { ConversationItem, ImageInput } from "@falcondeck/client-core";

function userMessage(attachment: ImageInput) {
  return {
    kind: "user_message",
    id: "user-media",
    text: "Use this reference",
    attachments: [attachment],
    created_at: "2026-08-09T12:00:00Z",
  } satisfies Extract<ConversationItem, { kind: "user_message" }>;
}

const remoteImage = {
  type: "image",
  id: "reference-image",
  name: "reference.png",
  mime_type: "image/png",
  url: "https://example.com/reference.png",
  local_path: null,
} satisfies ImageInput;

describe("user message media", () => {
  it("opens and closes an accessible full-size attachment preview", () => {
    render(<MessageCard item={userMessage(remoteImage)} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Preview reference.png" }),
    );
    expect(
      screen.getByRole("dialog", { name: "Preview reference.png" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "reference.png" })).toHaveLength(
      2,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Close image preview" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Preview reference.png" }),
    ).not.toBeInTheDocument();
  });

  it("keeps an open preview aligned with an authoritative attachment replacement", () => {
    const view = render(<MessageCard item={userMessage(remoteImage)} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Preview reference.png" }),
    );

    const replacement = {
      ...remoteImage,
      name: "updated-reference.png",
      url: "https://example.com/updated-reference.png",
    };
    view.rerender(<MessageCard item={userMessage(replacement)} />);

    const dialog = screen.getByRole("dialog", {
      name: "Preview updated-reference.png",
    });
    expect(
      within(dialog).getByRole("img", { name: "updated-reference.png" }),
    ).toHaveAttribute("src", "https://example.com/updated-reference.png");
  });

  it("closes a removed preview without resurrecting it when the id returns", () => {
    const item = userMessage(remoteImage);
    const view = render(<MessageCard item={item} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Preview reference.png" }),
    );

    view.rerender(<MessageCard item={{ ...item, attachments: [] }} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    view.rerender(<MessageCard item={item} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("dismisses the full-size preview from the keyboard", () => {
    render(<MessageCard item={userMessage(remoteImage)} />);
    const previewButton = screen.getByRole("button", {
      name: "Preview reference.png",
    });
    fireEvent.click(previewButton);

    fireEvent.keyDown(
      screen.getByRole("dialog", { name: "Preview reference.png" }),
      { key: "Escape" },
    );
    expect(
      screen.queryByRole("dialog", { name: "Preview reference.png" }),
    ).not.toBeInTheDocument();
    expect(previewButton).toHaveFocus();
  });

  it("replaces a full-size preview decode failure with an explicit receipt", () => {
    render(<MessageCard item={userMessage(remoteImage)} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Preview reference.png" }),
    );

    const dialog = screen.getByRole("dialog", {
      name: "Preview reference.png",
    });
    fireEvent.error(within(dialog).getByRole("img", { name: "reference.png" }));

    expect(
      within(dialog).getByRole("img", {
        name: "reference.png, image unavailable",
      }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Close image preview" }),
    ).toBeVisible();
  });

  it("replaces a decode failure with an explicit unavailable receipt", () => {
    render(<MessageCard item={userMessage(remoteImage)} />);
    fireEvent.error(screen.getByRole("img", { name: "reference.png" }));

    expect(
      screen.getByRole("img", { name: "reference.png, image unavailable" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Preview reference.png" }),
    ).not.toBeInTheDocument();
  });

  it("never passes an executable URL to the browser image decoder", () => {
    render(
      <MessageCard
        item={userMessage({ ...remoteImage, url: "javascript:alert(1)" })}
      />,
    );

    expect(
      screen.getByRole("img", { name: "reference.png, image unavailable" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("img", { name: "reference.png" }),
    ).not.toBeInTheDocument();
  });

  it("exposes a copy action for user-authored text", () => {
    render(<MessageCard item={userMessage(remoteImage)} />);
    expect(
      screen.getByRole("button", { name: "Copy message" }),
    ).toBeInTheDocument();
  });

  it("keeps edit and resend available for an image-only provider turn", async () => {
    const onEditResend = vi.fn();
    const item = {
      ...userMessage(remoteImage),
      text: "",
      turn_id: "turn-2",
      previous_turn_id: "turn-1",
    };
    render(<MessageCard item={item} onEditResend={onEditResend} />);

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Edit and resend in a new branch" }),
      );
    });

    expect(onEditResend).toHaveBeenCalledWith(item);
    expect(
      screen.queryByRole("button", { name: "Copy message" }),
    ).not.toBeInTheDocument();
  });

  it("derives an unnamed remote image label without exposing its query string", () => {
    render(
      <MessageCard
        item={userMessage({
          ...remoteImage,
          name: null,
          url: "https://example.com/reference.png?token=must-not-display",
        })}
      />,
    );

    fireEvent.error(screen.getByRole("img", { name: "reference.png" }));

    const unavailable = screen.getByRole("img", {
      name: "reference.png, image unavailable",
    });
    expect(unavailable).toHaveAttribute("title", "reference.png");
    expect(screen.queryByText(/token=/)).not.toBeInTheDocument();
    expect(unavailable).not.toHaveAttribute(
      "title",
      expect.stringContaining("token="),
    );
  });
});

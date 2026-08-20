import { fireEvent, render, screen } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MessageCard } from "@falcondeck/chat-ui";
import type { ConversationItem } from "@falcondeck/client-core";

function userMessage(text: string) {
  return {
    kind: "user_message",
    id: "user-long",
    text,
    attachments: [],
    created_at: "2026-08-20T12:00:00Z",
  } satisfies Extract<ConversationItem, { kind: "user_message" }>;
}

const wallOfText = Array.from({ length: 40 }, (_, i) => `Line ${i}`).join(
  "\n\n",
);

// jsdom performs no layout, so scrollHeight is always 0 and nothing would
// ever collapse; the clamp decision reads it, so make it controllable.
let mockedScrollHeight = 0;
const originalScrollHeight = Object.getOwnPropertyDescriptor(
  Element.prototype,
  "scrollHeight",
);

beforeAll(() => {
  Object.defineProperty(Element.prototype, "scrollHeight", {
    configurable: true,
    get: () => mockedScrollHeight,
  });
});

afterAll(() => {
  if (originalScrollHeight) {
    Object.defineProperty(
      Element.prototype,
      "scrollHeight",
      originalScrollHeight,
    );
  }
});

describe("long user message collapsing", () => {
  it("clamps a wall of text behind Show more and toggles open and closed", () => {
    mockedScrollHeight = 400;
    render(<MessageCard item={userMessage(wallOfText)} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Show the full message" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse the message" }));
    expect(
      screen.getByRole("button", { name: "Show the full message" }),
    ).toBeInTheDocument();
  });

  it("leaves short messages alone", () => {
    mockedScrollHeight = 100;
    render(<MessageCard item={userMessage("Short question")} />);
    expect(
      screen.queryByRole("button", { name: "Show the full message" }),
    ).not.toBeInTheDocument();
  });

  it("honors the preference being off", () => {
    mockedScrollHeight = 400;
    render(
      <MessageCard
        item={userMessage(wallOfText)}
        collapseLongUserMessages={false}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Show the full message" }),
    ).not.toBeInTheDocument();
  });
});

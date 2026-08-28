import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConversationItem } from "@falcondeck/client-core";

import { MessageCard } from "./message";

const createdAt = "2026-08-24T12:00:00Z";

function copyActionChrome(name: string) {
  const button = screen.getByRole("button", { name });
  let node: HTMLElement | null = button;
  while (node) {
    if (node.className.includes("[@media(pointer:fine)]:opacity-0")) {
      return node;
    }
    node = node.parentElement;
  }
  throw new Error(`hover-gated copy chrome not found for ${name}`);
}

function expectHoverGatedCopy(name: string, group: "message" | "review") {
  const chrome = copyActionChrome(name);
  expect(chrome.className).toContain(`group-[:hover]/${group}:opacity-100`);
  expect(chrome.className).toContain(
    `group-focus-within/${group}:opacity-100`,
  );
  expect(chrome.className).not.toContain("[@media(hover:none)]:opacity-100");
}

describe("message copy action visibility", () => {
  it("hides assistant copy until that message is hovered", () => {
    render(
      <MessageCard
        item={
          {
            kind: "assistant_message",
            id: "assistant-1",
            text: "Partial response",
            lifecycle: "complete",
            created_at: createdAt,
          } satisfies Extract<ConversationItem, { kind: "assistant_message" }>
        }
      />,
    );
    expectHoverGatedCopy("Copy response", "message");
  });

  it("hides user copy until that message is hovered", () => {
    render(
      <MessageCard
        item={
          {
            kind: "user_message",
            id: "user-1",
            text: "Use this reference",
            attachments: [],
            created_at: createdAt,
          } satisfies Extract<ConversationItem, { kind: "user_message" }>
        }
      />,
    );
    expectHoverGatedCopy("Copy message", "message");
  });

  it("hides code-review copy until that review is hovered", () => {
    render(
      <MessageCard
        item={
          {
            kind: "code_review",
            id: "review-1",
            subject: "current changes",
            content: "## Findings\n\n- Fix the reconnect race.",
            lifecycle: "complete",
            created_at: createdAt,
          } satisfies Extract<ConversationItem, { kind: "code_review" }>
        }
      />,
    );
    expectHoverGatedCopy("Copy code review", "review");
  });
});

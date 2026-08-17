import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { ConversationItem } from "@falcondeck/client-core";

import { Conversation } from "./conversation";

const ENTER_CLASS = "fd-conversation-block--enter";

function userMessage(id: string, text: string): ConversationItem {
  return {
    kind: "user_message",
    id,
    text,
    attachments: [],
    created_at: "2026-08-17T10:00:00Z",
  };
}

function assistantMessage(id: string, text: string): ConversationItem {
  return {
    kind: "assistant_message",
    id,
    text,
    created_at: "2026-08-17T10:00:05Z",
  };
}

function enteringBlockIds(container: HTMLElement): string[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(`.${ENTER_CLASS}`),
  ).map((el) => el.dataset.conversationBlockId ?? "");
}

describe("Conversation entrance animation", () => {
  it("mounts existing history statically", () => {
    const { container } = render(
      <Conversation
        threadKey="t1"
        items={[userMessage("u1", "hello"), assistantMessage("a1", "hi")]}
      />,
    );
    expect(enteringBlockIds(container)).toEqual([]);
  });

  it("animates a user message appended to an on-screen thread", () => {
    const history = [userMessage("u1", "hello"), assistantMessage("a1", "hi")];
    const { container, rerender } = render(
      <Conversation threadKey="t1" items={history} />,
    );

    rerender(
      <Conversation
        threadKey="t1"
        items={[...history, userMessage("u2", "follow-up")]}
        isSending
      />,
    );

    const entering = enteringBlockIds(container);
    expect(entering).toHaveLength(1);
    expect(
      container.querySelector(`.${ENTER_CLASS}`)?.textContent,
    ).toContain("follow-up");
    // The grant survives later renders so re-renders can't cancel the
    // animation midway.
    rerender(
      <Conversation
        threadKey="t1"
        items={[...history, userMessage("u2", "follow-up")]}
        isThinking
      />,
    );
    expect(enteringBlockIds(container)).toEqual(entering);
  });

  it("does not animate assistant replies", () => {
    const history = [userMessage("u1", "hello")];
    const { container, rerender } = render(
      <Conversation threadKey="t1" items={history} />,
    );

    rerender(
      <Conversation
        threadKey="t1"
        items={[...history, assistantMessage("a1", "hi")]}
      />,
    );
    expect(enteringBlockIds(container)).toEqual([]);
  });

  it("does not animate older pages prepended by load-earlier", () => {
    const recent = [userMessage("u5", "recent"), assistantMessage("a5", "ok")];
    const { container, rerender } = render(
      <Conversation threadKey="t1" items={recent} hasOlder />,
    );

    rerender(
      <Conversation
        threadKey="t1"
        items={[
          userMessage("u1", "older question"),
          assistantMessage("a1", "older answer"),
          ...recent,
        ]}
      />,
    );
    expect(enteringBlockIds(container)).toEqual([]);
  });

  it("does not animate history that arrives while hydrating", () => {
    const { container, rerender } = render(
      <Conversation threadKey="t1" items={[]} isLoading />,
    );

    rerender(
      <Conversation
        threadKey="t1"
        items={[userMessage("u1", "hello"), assistantMessage("a1", "hi")]}
      />,
    );
    expect(enteringBlockIds(container)).toEqual([]);
  });

  it("does not animate when switching to another thread", () => {
    const { container, rerender } = render(
      <Conversation threadKey="t1" items={[userMessage("u1", "hello")]} />,
    );

    rerender(
      <Conversation
        threadKey="t2"
        items={[userMessage("u9", "other thread"), assistantMessage("a9", "x")]}
      />,
    );
    expect(enteringBlockIds(container)).toEqual([]);
  });

  it("animates the first message sent into a brand-new thread", () => {
    const { container, rerender } = render(
      <Conversation threadKey="t1" items={[]} />,
    );

    rerender(
      <Conversation
        threadKey="t1"
        items={[userMessage("u1", "first prompt")]}
        isSending
      />,
    );
    expect(enteringBlockIds(container)).toHaveLength(1);
  });
});

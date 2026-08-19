import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Conversation } from "./conversation";

describe("Read Aloud action", () => {
  it("sits alongside Copy and plays only completed assistant responses", () => {
    const play = vi.fn();
    const readAloud = {
      activeMessageId: null,
      loadingMessageId: null,
      awaitingGestureMessageId: null,
      play,
      resume: vi.fn(),
      stop: vi.fn(),
    };
    render(
      <Conversation
        items={[
          {
            kind: "assistant_message",
            id: "complete",
            text: "A completed answer",
            lifecycle: "complete",
            created_at: "2026-08-18T10:00:00Z",
          },
          {
            kind: "assistant_message",
            id: "streaming",
            text: "Still arriving",
            lifecycle: "streaming",
            created_at: "2026-08-18T10:01:00Z",
          },
        ]}
        readAloud={readAloud}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Read response aloud" }));
    expect(play).toHaveBeenCalledWith("complete", "A completed answer");
    expect(screen.getAllByRole("button", { name: "Read response aloud" })).toHaveLength(1);
  });

  it("stops playback when navigating away from its conversation", () => {
    const stop = vi.fn();
    const readAloud = {
      activeMessageId: "complete",
      loadingMessageId: null,
      awaitingGestureMessageId: null,
      play: vi.fn(),
      resume: vi.fn(),
      stop,
    };
    const { rerender } = render(
      <Conversation threadKey="first" items={[]} readAloud={readAloud} />,
    );
    rerender(<Conversation threadKey="second" items={[]} readAloud={readAloud} />);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("prevents duplicate synthesis while preparing and offers a playback retry", () => {
    const resume = vi.fn();
    const readAloud = {
      activeMessageId: null,
      loadingMessageId: "complete",
      awaitingGestureMessageId: null,
      play: vi.fn(),
      resume,
      stop: vi.fn(),
    };
    const item = {
      kind: "assistant_message" as const,
      id: "complete",
      text: "A completed answer",
      lifecycle: "complete" as const,
      created_at: "2026-08-18T10:00:00Z",
    };
    const { rerender } = render(
      <Conversation items={[item]} readAloud={readAloud} />,
    );
    expect(
      screen.getByRole("button", { name: "Read response aloud" }),
    ).toHaveProperty("disabled", true);

    rerender(
      <Conversation
        items={[item]}
        readAloud={{ ...readAloud, loadingMessageId: null, awaitingGestureMessageId: "complete" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Play response" }));
    expect(resume).toHaveBeenCalledOnce();
  });
});

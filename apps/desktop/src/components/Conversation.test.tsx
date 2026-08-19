import React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Conversation } from "@falcondeck/chat-ui";

function captureResizeObservers() {
  const callbacks: ResizeObserverCallback[] = [];
  const OriginalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(callback: ResizeObserverCallback) {
      callbacks.push(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  return {
    flush() {
      act(() => {
        for (const callback of callbacks) {
          callback([], {} as ResizeObserver);
        }
      });
    },
    restore() {
      globalThis.ResizeObserver = OriginalResizeObserver;
    },
    get length() {
      return callbacks.length;
    },
  };
}

describe("Conversation empty state", () => {
  it("offers selected assistant text as composer context", () => {
    const onQuoteSelection = vi.fn();
    render(
      <Conversation
        items={[
          {
            kind: "assistant_message",
            id: "assistant-selectable",
            text: "Choose this phrase",
            lifecycle: "complete",
            created_at: "2026-08-12T12:00:00Z",
          },
        ]}
        onQuoteSelection={onQuoteSelection}
      />,
    );

    const phrase = screen.getByText("Choose this phrase");
    const range = document.createRange();
    range.selectNodeContents(phrase);
    Object.defineProperty(range, "getBoundingClientRect", {
      value: () => ({
        left: 20,
        top: 80,
        width: 120,
        height: 20,
        right: 140,
        bottom: 100,
      }),
    });
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.mouseUp(screen.getByRole("log", { name: "Conversation" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Add selected text to chat" }),
    );

    expect(onQuoteSelection).toHaveBeenCalledWith("Choose this phrase");
  });

  it("dismisses the add-to-chat action when the browser selection is cleared", () => {
    render(
      <Conversation
        items={[
          {
            kind: "user_message",
            id: "user-selectable",
            text: "Keep this selection",
            attachments: [],
            created_at: "2026-08-12T12:00:00Z",
          },
        ]}
        onQuoteSelection={vi.fn()}
      />,
    );

    const phrase = screen.getByText("Keep this selection");
    const range = document.createRange();
    range.selectNodeContents(phrase);
    Object.defineProperty(range, "getBoundingClientRect", {
      value: () => ({
        left: 20,
        top: 80,
        width: 120,
        height: 20,
        right: 140,
        bottom: 100,
      }),
    });
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    fireEvent.mouseUp(screen.getByRole("log", { name: "Conversation" }));

    expect(
      screen.getByRole("button", { name: "Add selected text to chat" }),
    ).toBeInTheDocument();
    selection?.removeAllRanges();
    fireEvent(document, new Event("selectionchange"));
    expect(
      screen.queryByRole("button", { name: "Add selected text to chat" }),
    ).toBeNull();
  });

  it("exposes transcript semantics without turning each token into a live announcement", () => {
    render(<Conversation items={[]} isThinking />);

    const transcript = screen.getByRole("log", { name: "Conversation" });
    expect(transcript).toHaveAttribute("aria-busy", "true");
    expect(transcript).toHaveAttribute("aria-live", "off");
  });

  it("shows a specific preparation status in an otherwise empty conversation", () => {
    render(
      <Conversation
        items={[]}
        isSending
        sendingLabel="Summarizing previous conversation…"
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Summarizing previous conversation…",
    );
    expect(
      screen.queryByText("Ready for instructions"),
    ).not.toBeInTheDocument();
  });

  it("announces completion once without exposing streamed tokens as live text", () => {
    const streaming = {
      kind: "assistant_message" as const,
      id: "assistant-stream",
      text: "First token",
      lifecycle: "streaming" as const,
      created_at: "2026-08-08T12:00:00Z",
    };
    const { container, rerender } = render(
      <Conversation threadKey="thread-1" items={[streaming]} isThinking />,
    );
    const announcer = container.querySelector(
      "[data-response-completion-announcer]",
    );

    expect(announcer).toBeEmptyDOMElement();

    rerender(
      <Conversation
        threadKey="thread-1"
        items={[{ ...streaming, text: "First token, then more" }]}
        isThinking
      />,
    );
    expect(announcer).toBeEmptyDOMElement();

    rerender(
      <Conversation
        threadKey="thread-1"
        items={[
          { ...streaming, text: "Finished response", lifecycle: "complete" },
        ]}
      />,
    );
    expect(announcer).toHaveTextContent("Response complete");
    expect(announcer).not.toHaveTextContent("Finished response");

    rerender(
      <Conversation
        threadKey="thread-1"
        items={[
          { ...streaming, text: "Finished response", lifecycle: "complete" },
        ]}
        isThinking
      />,
    );
    expect(announcer).toBeEmptyDOMElement();
  });

  it("does not announce completed history on load or thread switch", () => {
    const completed = {
      kind: "assistant_message" as const,
      id: "assistant-history",
      text: "Existing response",
      lifecycle: "complete" as const,
      created_at: "2026-08-08T12:00:00Z",
    };
    const { container, rerender } = render(
      <Conversation threadKey="thread-1" items={[completed]} />,
    );
    const announcer = container.querySelector(
      "[data-response-completion-announcer]",
    );

    expect(announcer).toBeEmptyDOMElement();
    rerender(
      <Conversation
        threadKey="thread-2"
        items={[{ ...completed, id: "assistant-other-thread" }]}
      />,
    );
    expect(announcer).toBeEmptyDOMElement();
  });

  it("waits for the exact streamed assistant to complete after busy clears", () => {
    const streaming = {
      kind: "assistant_message" as const,
      id: "assistant-split-update",
      text: "Still arriving",
      lifecycle: "streaming" as const,
      created_at: "2026-08-08T12:00:00Z",
    };
    const { container, rerender } = render(
      <Conversation threadKey="thread-1" items={[streaming]} isThinking />,
    );
    const announcer = container.querySelector(
      "[data-response-completion-announcer]",
    );

    rerender(<Conversation threadKey="thread-1" items={[streaming]} />);
    expect(announcer).toBeEmptyDOMElement();

    rerender(
      <Conversation
        threadKey="thread-1"
        items={[{ ...streaming, text: "Now complete", lifecycle: "complete" }]}
      />,
    );
    expect(announcer).toHaveTextContent("Response complete");
  });

  it("waits for the enclosing turn when assistant content completes first", () => {
    const streaming = {
      kind: "assistant_message" as const,
      id: "assistant-content-first",
      text: "Still arriving",
      lifecycle: "streaming" as const,
      created_at: "2026-08-08T12:00:00Z",
    };
    const { container, rerender } = render(
      <Conversation threadKey="thread-1" items={[streaming]} isThinking />,
    );
    const announcer = container.querySelector(
      "[data-response-completion-announcer]",
    );

    rerender(
      <Conversation
        threadKey="thread-1"
        items={[{ ...streaming, text: "Content done", lifecycle: "complete" }]}
        isThinking
      />,
    );
    expect(announcer).toBeEmptyDOMElement();

    rerender(
      <Conversation
        threadKey="thread-1"
        items={[{ ...streaming, text: "Content done", lifecycle: "complete" }]}
      />,
    );
    expect(announcer).toHaveTextContent("Response complete");
  });

  it("does not announce a previous completed answer when a new send fails", () => {
    const previousAnswer = {
      kind: "assistant_message" as const,
      id: "assistant-previous",
      text: "Previous answer",
      lifecycle: "complete" as const,
      created_at: "2026-08-08T12:00:00Z",
    };
    const { container, rerender } = render(
      <Conversation threadKey="thread-1" items={[previousAnswer]} />,
    );
    const announcer = container.querySelector(
      "[data-response-completion-announcer]",
    );

    rerender(
      <Conversation threadKey="thread-1" items={[previousAnswer]} isSending />,
    );
    rerender(<Conversation threadKey="thread-1" items={[previousAnswer]} />);

    expect(announcer).toBeEmptyDOMElement();
  });

  it("shows the empty state on an idle empty thread", () => {
    render(<Conversation items={[]} />);

    expect(screen.getByText("Ready for instructions")).toBeInTheDocument();
  });

  it("clears the previous transcript when switching to a new thread", () => {
    const previous = {
      kind: "tool_call" as const,
      id: "patch-from-previous-thread",
      title: "Patch",
      tool_kind: "other" as const,
      status: "completed",
      output: "old tool output",
      exit_code: 0,
      display: {
        is_read_only: false,
        has_side_effect: true,
        is_error: false,
        artifact_kind: "diff" as const,
        activity_kind: "edit" as const,
        history_mode: "full" as const,
        summary_hint: null,
      },
      created_at: "2026-08-08T12:00:00Z",
      completed_at: "2026-08-08T12:00:01Z",
    };
    const { rerender } = render(
      <Conversation threadKey="workspace:previous" items={[previous]} />,
    );

    expect(screen.getByText("Patch")).toBeInTheDocument();

    rerender(
      <Conversation
        threadKey="workspace:new"
        items={[]}
        emptyState={<p>What could we make better in lucipic?</p>}
      />,
    );

    expect(screen.queryByText("Patch")).not.toBeInTheDocument();
    expect(
      screen.getByText("What could we make better in lucipic?"),
    ).toBeInTheDocument();
  });

  it("yields to the thinking indicator once a prompt is submitted", () => {
    // The submit gap: the prompt is in flight but the daemon has not echoed it
    // into the transcript yet, so items is still empty.
    render(<Conversation items={[]} isThinking />);

    expect(screen.queryByText("Ready for instructions")).toBeNull();
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
  });

  it("shows an optimistic sending indicator before daemon activity arrives", () => {
    render(
      <Conversation
        items={[
          {
            kind: "user_message",
            id: "user-1",
            text: "Did you implement it?",
            attachments: [],
            created_at: "2026-08-08T12:00:00Z",
          },
        ]}
        isSending
        isThinking
      />,
    );

    expect(screen.queryByText("Ready for instructions")).toBeNull();
    expect(screen.getByText("Sending…")).toBeInTheDocument();
    expect(screen.queryByText("Thinking…")).toBeNull();
  });

  it("yields to the approval notice when an empty-transcript turn is blocked", () => {
    render(<Conversation items={[]} isWaitingForInput />);

    expect(screen.queryByText("Ready for instructions")).toBeNull();
    expect(screen.getByText(/Waiting for approval/)).toBeInTheDocument();
  });

  it("shows nothing while the thread detail is still loading", () => {
    render(<Conversation items={[]} isLoading />);

    expect(screen.queryByText("Ready for instructions")).toBeNull();
    expect(screen.queryByText("Thinking…")).toBeNull();
  });

  it("offers one accessible earlier-history action and disables it while loading", () => {
    const onLoadOlder = vi.fn();
    const { rerender } = render(
      <Conversation items={[]} hasOlder onLoadOlder={onLoadOlder} />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Load earlier messages" }),
    );
    expect(onLoadOlder).toHaveBeenCalledOnce();

    rerender(
      <Conversation
        items={[]}
        hasOlder
        isLoadingOlder
        onLoadOlder={onLoadOlder}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Loading earlier messages" }),
    ).toBeDisabled();
  });

  it("defers browser layout for old blocks while keeping recent streaming context eager", () => {
    const items = Array.from({ length: 45 }, (_, index) => ({
      kind: "assistant_message" as const,
      id: `assistant-${index}`,
      text: `Response ${index}`,
      lifecycle: "complete" as const,
      created_at: "2026-08-08T12:00:00Z",
    }));
    const { container } = render(<Conversation items={items} />);

    const first = container.querySelector(
      '[data-conversation-block-id="assistant_message:assistant-0"]',
    );
    const fifth = container.querySelector(
      '[data-conversation-block-id="assistant_message:assistant-4"]',
    );
    const sixth = container.querySelector(
      '[data-conversation-block-id="assistant_message:assistant-5"]',
    );
    const tail = container.querySelector(
      '[data-conversation-block-id="assistant_message:assistant-44"]',
    );

    expect(first).toHaveClass("fd-conversation-block--deferred");
    expect(fifth).toHaveClass("fd-conversation-block--deferred");
    expect(sixth).not.toHaveClass("fd-conversation-block--deferred");
    expect(tail).not.toHaveClass("fd-conversation-block--deferred");
  });

  it("keeps the visible block anchored when an older page prepends above it", () => {
    const current = {
      kind: "user_message" as const,
      id: "user-current",
      text: "Current visible message",
      attachments: [],
      created_at: "2026-08-08T12:00:01Z",
    };
    const older = {
      kind: "user_message" as const,
      id: "user-older",
      text: "Earlier message",
      attachments: [],
      created_at: "2026-08-08T12:00:00Z",
    };
    const { rerender } = render(
      <Conversation items={[current]} hasOlder onLoadOlder={vi.fn()} />,
    );
    const transcript = screen.getByRole("log", { name: "Conversation" });
    const anchoredBlock = transcript.querySelector<HTMLElement>(
      "[data-conversation-block-id]",
    );
    expect(anchoredBlock).not.toBeNull();

    let scrollHeight = 1_000;
    let blockTop = 100;
    Object.defineProperty(transcript, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    transcript.scrollTop = 200;
    anchoredBlock!.getBoundingClientRect = () =>
      ({
        top: blockTop,
      }) as DOMRect;

    fireEvent.click(
      screen.getByRole("button", { name: "Load earlier messages" }),
    );
    // A streaming tail can grow while the page request is in flight. Because
    // that growth is below the anchor it must not consume the prepend anchor.
    scrollHeight = 1_100;
    rerender(
      <Conversation
        items={[current]}
        hasOlder
        isLoadingOlder
        onLoadOlder={vi.fn()}
      />,
    );
    expect(transcript.scrollTop).toBe(200);

    scrollHeight = 1_300;
    blockTop = 400;
    rerender(
      <Conversation
        items={[older, current]}
        hasOlder
        isLoadingOlder
        onLoadOlder={vi.fn()}
      />,
    );

    expect(transcript.scrollTop).toBe(500);
  });

  it("snaps a send to the bottom for a reader hovering just above the tail", () => {
    const item = {
      kind: "user_message" as const,
      id: "user-1",
      text: "Earlier message",
      attachments: [],
      created_at: "2026-08-08T12:00:00Z",
    };
    const { rerender } = render(
      <Conversation threadKey="thread-1" items={[item]} />,
    );
    const transcript = screen.getByRole("log", { name: "Conversation" });
    Object.defineProperty(transcript, "scrollHeight", {
      configurable: true,
      get: () => 1_000,
    });
    Object.defineProperty(transcript, "clientHeight", {
      configurable: true,
      get: () => 500,
    });
    // Parked 150px above the tail — inside the jump-button threshold.
    transcript.scrollTop = 350;
    fireEvent.scroll(transcript);

    // Run the smooth-scroll glide to completion synchronously: hand each
    // frame a timestamp past the animation's duration.
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((frame) => {
        frame(performance.now() + 10_000);
        return 0;
      });
    try {
      rerender(<Conversation threadKey="thread-1" items={[item]} isSending />);
    } finally {
      raf.mockRestore();
    }

    expect(transcript.scrollTop).toBe(500);
  });

  it("keeps a reader's place on send when they are far up the transcript", () => {
    const item = {
      kind: "user_message" as const,
      id: "user-1",
      text: "Earlier message",
      attachments: [],
      created_at: "2026-08-08T12:00:00Z",
    };
    const { rerender } = render(
      <Conversation threadKey="thread-1" items={[item]} />,
    );
    const transcript = screen.getByRole("log", { name: "Conversation" });
    Object.defineProperty(transcript, "scrollHeight", {
      configurable: true,
      get: () => 1_000,
    });
    Object.defineProperty(transcript, "clientHeight", {
      configurable: true,
      get: () => 500,
    });
    transcript.scrollTop = 100;
    fireEvent.scroll(transcript);

    // Complete any glide synchronously so a wrongly-started one is visible.
    const raf = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((frame) => {
        frame(performance.now() + 10_000);
        return 0;
      });
    try {
      rerender(<Conversation threadKey="thread-1" items={[item]} isSending />);
    } finally {
      raf.mockRestore();
    }

    expect(transcript.scrollTop).toBe(100);
  });

  it("stays pinned to the bottom when the viewport shrinks while following", () => {
    const observers = captureResizeObservers();
    const item = {
      kind: "user_message" as const,
      id: "user-1",
      text: "Earlier message",
      attachments: [],
      created_at: "2026-08-08T12:00:00Z",
    };
    try {
      render(
        <Conversation threadKey="thread-1" items={[item]} isThinking />,
      );
      const transcript = screen.getByRole("log", { name: "Conversation" });
      let clientHeight = 500;
      Object.defineProperty(transcript, "scrollHeight", {
        configurable: true,
        get: () => 1_000,
      });
      Object.defineProperty(transcript, "clientHeight", {
        configurable: true,
        get: () => clientHeight,
      });
      // Already at the tail: 1000 - 500.
      transcript.scrollTop = 500;
      fireEvent.scroll(transcript);

      // Composer grew; the transcript viewport lost 80px.
      clientHeight = 420;
      expect(observers.length).toBeGreaterThan(0);
      observers.flush();

      expect(transcript.scrollTop).toBe(580);
    } finally {
      observers.restore();
    }
  });

  it("keeps a reader's place when the viewport shrinks away from the tail", () => {
    const observers = captureResizeObservers();
    const item = {
      kind: "user_message" as const,
      id: "user-1",
      text: "Earlier message",
      attachments: [],
      created_at: "2026-08-08T12:00:00Z",
    };
    try {
      render(
        <Conversation threadKey="thread-1" items={[item]} isThinking />,
      );
      const transcript = screen.getByRole("log", { name: "Conversation" });
      let clientHeight = 500;
      Object.defineProperty(transcript, "scrollHeight", {
        configurable: true,
        get: () => 1_000,
      });
      Object.defineProperty(transcript, "clientHeight", {
        configurable: true,
        get: () => clientHeight,
      });
      transcript.scrollTop = 100;
      fireEvent.scroll(transcript);

      clientHeight = 420;
      observers.flush();

      expect(transcript.scrollTop).toBe(100);
    } finally {
      observers.restore();
    }
  });

  it("copies a complete assistant response from a keyboard-accessible action", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <Conversation
        items={[
          {
            kind: "assistant_message",
            id: "assistant-1",
            text: "World-class response",
            created_at: "2026-08-08T12:00:00Z",
          },
        ]}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
    });
    expect(writeText).toHaveBeenCalledWith("World-class response");
  });

  it("copies agent actions semantically without leaking directive transport syntax", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <Conversation
        items={[
          {
            kind: "assistant_message",
            id: "assistant-directive",
            text: 'Release completed.\n::git-commit{cwd="/workspace/falcondeck" commit=abc123}',
            lifecycle: "complete",
            created_at: "2026-08-08T12:00:00Z",
          },
        ]}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
    });
    expect(writeText).toHaveBeenCalledWith(
      "Release completed.\nAgent action: git commit · cwd: /workspace/falcondeck · commit: abc123",
    );
  });

  it("does not copy a half-streamed directive before it becomes visible", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <Conversation
        items={[
          {
            kind: "assistant_message",
            id: "assistant-streaming-directive",
            text: 'Saved.\n::git-commit{cwd="/workspace/falcondeck"',
            lifecycle: "streaming",
            created_at: "2026-08-08T12:00:00Z",
          },
        ]}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
    });
    expect(writeText).toHaveBeenCalledWith("Saved.");
  });

  it("does not offer retry on a terminal answer", () => {
    const onRetryResponse = vi.fn();
    const source = {
      kind: "user_message" as const,
      id: "user-retry",
      text: "Original prompt",
      attachments: [],
      turn_id: "turn-2",
      previous_turn_id: "turn-1",
      created_at: "2026-08-08T12:00:00Z",
    };
    render(
      <Conversation
        items={[
          source,
          {
            kind: "assistant_message",
            id: "assistant-retry",
            text: "A completed answer",
            phase: "final_answer",
            lifecycle: "complete",
            created_at: "2026-08-08T12:00:01Z",
          },
        ]}
        onRetryResponse={onRetryResponse}
      />,
    );

    expect(
      screen.queryByRole("button", {
        name: "Try response again in a new branch",
      }),
    ).toBeNull();
    expect(onRetryResponse).not.toHaveBeenCalled();
  });

  it("does not offer retry for commentary or an unsafe steering message", () => {
    render(
      <Conversation
        items={[
          {
            kind: "user_message",
            id: "steer",
            text: "Change direction",
            attachments: [],
            turn_id: null,
            created_at: "2026-08-08T12:00:00Z",
          },
          {
            kind: "assistant_message",
            id: "commentary",
            text: "Changing direction",
            phase: "commentary",
            lifecycle: "complete",
            created_at: "2026-08-08T12:00:01Z",
          },
        ]}
        onRetryResponse={vi.fn()}
      />,
    );

    expect(
      screen.queryByRole("button", {
        name: "Try response again in a new branch",
      }),
    ).toBeNull();
  });
});

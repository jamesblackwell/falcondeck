import { act, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Conversation } from "./conversation";

let resize: () => void;
let frames: Map<number, FrameRequestCallback>;

beforeEach(() => {
  frames = new Map();
  let id = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
    frames.delete(id);
  });
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1000);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function openThread() {
  const { container } = render(<Conversation threadKey="scroll-test" items={[
    { kind: "assistant_message", id: "a1", text: "Reply", created_at: "2026-09-07T10:00:00Z" },
  ]} />);
  return container.querySelector("[data-conversation-transcript]")!.parentElement!;
}

function flushFrames() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(performance.now()));
  });
}

describe("Conversation scrolling", () => {
  it("keeps a small upward scroll detached when content resizes", () => {
    const scroll = openThread();
    scroll.scrollTop = 480;
    fireEvent.scroll(scroll);
    act(() => resize());
    expect(scroll.scrollTop).toBe(480);
  });

  it("stops following on upward wheel input before the scroll event arrives", () => {
    const scroll = openThread();
    fireEvent.wheel(scroll, { deltaY: -5 });
    scroll.scrollTop = 495;
    act(() => resize());
    expect(scroll.scrollTop).toBe(495);
  });

  it("cancels the deferred opening snap when the reader scrolls up", () => {
    const scroll = openThread();
    flushFrames();
    fireEvent.wheel(scroll, { deltaY: -20 });
    scroll.scrollTop = 480;
    fireEvent.scroll(scroll);
    flushFrames();
    expect(scroll.scrollTop).toBe(480);
  });

  it("resumes following after scrolling back toward the bottom", () => {
    const scroll = openThread();
    scroll.scrollTop = 300;
    fireEvent.scroll(scroll);
    act(() => resize());
    expect(scroll.scrollTop).toBe(300);
    scroll.scrollTop = 490;
    fireEvent.scroll(scroll);
    act(() => resize());
    expect(scroll.scrollTop).toBe(500);
  });

  function anchoredBlock(scroll: HTMLElement, documentTop: () => number) {
    const block = scroll.querySelector<HTMLElement>("[data-conversation-block-id]")!;
    block.getBoundingClientRect = () =>
      ({ top: documentTop() - scroll.scrollTop }) as DOMRect;
    scroll.getBoundingClientRect = () => ({ top: 0, left: 0, width: 800, height: 500 }) as DOMRect;
    document.elementFromPoint = () => block;
  }

  it("holds a detached reader's content still when height changes above it", () => {
    const scroll = openThread();
    let blockTop = 420;
    anchoredBlock(scroll, () => blockTop);

    scroll.scrollTop = 300;
    fireEvent.scroll(scroll);
    blockTop = 490;
    act(() => resize());
    expect(scroll.scrollTop).toBe(370);
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it("cancels a height change that lands during the reader's own scroll", () => {
    const scroll = openThread();
    let blockTop = 420;
    anchoredBlock(scroll, () => blockTop);

    scroll.scrollTop = 300;
    fireEvent.scroll(scroll);
    // A deferred block resolves in the same frame as the next wheel step.
    blockTop = 754;
    scroll.scrollTop = 280;
    fireEvent.scroll(scroll);
    expect(scroll.scrollTop).toBe(614);
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it("does not read the anchor's correction as the reader scrolling", () => {
    const scroll = openThread();
    let blockTop = 420;
    anchoredBlock(scroll, () => blockTop);

    scroll.scrollTop = 300;
    fireEvent.scroll(scroll);
    blockTop = 490;
    act(() => resize());
    fireEvent.scroll(scroll);
    act(() => resize());
    expect(scroll.scrollTop).toBe(370);
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it("does not double the reader's scroll when their anchor has gone", () => {
    const scroll = openThread();
    anchoredBlock(scroll, () => 420);
    scroll.scrollTop = 300;
    fireEvent.scroll(scroll);
    scroll.querySelector("[data-conversation-block-id]")!.remove();
    scroll.scrollTop = 280;
    fireEvent.scroll(scroll);
    expect(scroll.scrollTop).toBe(280);
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it("keeps a reader's scroll that arrives before its scroll event", () => {
    const scroll = openThread();
    anchoredBlock(scroll, () => 420);
    scroll.scrollTop = 300;
    fireEvent.scroll(scroll);

    scroll.scrollTop = 280;
    act(() => resize());
    expect(scroll.scrollTop).toBe(280);
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it("applies only the layout drift when it lands mid-scroll", () => {
    const scroll = openThread();
    let blockTop = 420;
    anchoredBlock(scroll, () => blockTop);
    scroll.scrollTop = 300;
    fireEvent.scroll(scroll);

    scroll.scrollTop = 280;
    blockTop = 430;
    act(() => resize());
    expect(scroll.scrollTop).toBe(290);

    // The echo must neither undo that nor re-apply the reader's movement.
    fireEvent.scroll(scroll);
    expect(scroll.scrollTop).toBe(290);
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it("holds the reader when height moves between blocks with no resize", async () => {
    const scroll = openThread();
    let blockTop = 420;
    anchoredBlock(scroll, () => blockTop);
    scroll.scrollTop = 300;
    fireEvent.scroll(scroll);

    blockTop = 460;
    await act(async () => {
      scroll
        .querySelector("[data-conversation-transcript]")!
        .append(document.createElement("div"));
    });
    expect(scroll.scrollTop).toBe(340);
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it("clears the previous thread's floor while the next one loads", () => {
    const items = [
      { kind: "assistant_message" as const, id: "a1", text: "Reply", created_at: "2026-09-07T10:00:00Z" },
    ];
    const { container, rerender } = render(<Conversation threadKey="long" items={items} />);
    const floor = container.querySelector<HTMLElement>("[data-conversation-scroll-floor]")!;
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(1200);
    act(() => resize());
    expect(floor.style.height).toBe("1200px");

    rerender(<Conversation threadKey="short" items={[]} isLoading />);
    expect(floor.style.height).toBe("");
  });

  it("eases real shrinkage so the tail never lands in one frame", () => {
    vi.spyOn(performance, "now").mockReturnValue(0);
    const scroll = openThread();
    const offsetHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get");
    offsetHeight.mockReturnValue(1200);
    act(() => resize());
    flushFrames();
    const floor = scroll.querySelector<HTMLElement>("[data-conversation-scroll-floor]")!;

    offsetHeight.mockReturnValue(700);
    act(() => resize());
    expect(floor.style.height).toBe("1200px");

    vi.spyOn(performance, "now").mockReturnValue(100);
    flushFrames();
    const halfway = Number.parseFloat(floor.style.height);
    expect(halfway).toBeLessThan(1200);
    expect(halfway).toBeGreaterThan(700);

    vi.spyOn(performance, "now").mockReturnValue(1000);
    flushFrames();
    expect(floor.style.height).toBe("700px");
  });

  it("eases a second collapse from wherever the first release has reached", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(0);
    const scroll = openThread();
    const offsetHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get");
    offsetHeight.mockReturnValue(1200);
    act(() => resize());
    flushFrames();
    const floor = scroll.querySelector<HTMLElement>("[data-conversation-scroll-floor]")!;

    offsetHeight.mockReturnValue(1000);
    act(() => resize());
    now.mockReturnValue(200);
    flushFrames();
    const reached = Number.parseFloat(floor.style.height);

    offsetHeight.mockReturnValue(500);
    act(() => resize());
    now.mockReturnValue(216);
    flushFrames();
    const next = Number.parseFloat(floor.style.height);
    expect(reached - next).toBeLessThan(150);
    expect(next).toBeLessThanOrEqual(reached);

    now.mockReturnValue(1000);
    flushFrames();
    expect(floor.style.height).toBe("500px");
  });

  it("drops the floor at once for reduced motion", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const scroll = openThread();
    const offsetHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get");
    offsetHeight.mockReturnValue(1200);
    act(() => resize());
    offsetHeight.mockReturnValue(700);
    act(() => resize());
    const floor = scroll.querySelector<HTMLElement>("[data-conversation-scroll-floor]")!;
    expect(floor.style.height).toBe("700px");
  });

  it("holds the scrollable height through the finished message's swap", () => {
    const item = {
      kind: "assistant_message" as const,
      id: "a1",
      text: "Reply",
      lifecycle: "streaming" as const,
      created_at: "2026-09-07T10:00:00Z",
    };
    const { container, rerender } = render(
      <Conversation threadKey="end" items={[item]} isThinking />,
    );
    const offsetHeight = vi.spyOn(HTMLElement.prototype, "offsetHeight", "get");
    offsetHeight.mockReturnValue(1200);
    act(() => resize());
    const floor = container.querySelector<HTMLElement>("[data-conversation-scroll-floor]")!;
    expect(floor.style.height).toBe("1200px");

    // Mid-swap the transcript is transiently short. Only the settled size
    // reported by the observer may move the floor, so a commit must not.
    offsetHeight.mockReturnValue(300);
    rerender(
      <Conversation threadKey="end" items={[{ ...item, lifecycle: "complete" }]} />,
    );
    expect(floor.style.height).toBe("1200px");
    expect(floor.parentElement).toBe(
      container.querySelector("[data-conversation-transcript]")!.parentElement,
    );
  });

  it("leaves anchoring to engines that do it natively", () => {
    vi.stubGlobal("CSS", { supports: () => true });
    const scroll = openThread();
    let blockTop = 420;
    anchoredBlock(scroll, () => blockTop);

    scroll.scrollTop = 300;
    fireEvent.scroll(scroll);
    // The engine has already moved scrollTop to match; adding to it would
    // shift the content a second time.
    blockTop = 520;
    scroll.scrollTop = 400;
    fireEvent.scroll(scroll);
    act(() => resize());
    expect(scroll.scrollTop).toBe(400);
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it("leaves a following reader on the tail, not the anchor", () => {
    const scroll = openThread();
    const elementFromPoint = vi.fn(() => null);
    document.elementFromPoint = elementFromPoint;
    act(() => resize());
    expect(scroll.scrollTop).toBe(500);
    expect(elementFromPoint).not.toHaveBeenCalled();
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it("re-engages following after the anchor held on the way back down", () => {
    const scroll = openThread();
    anchoredBlock(scroll, () => 420);

    scroll.scrollTop = 300;
    fireEvent.scroll(scroll);
    act(() => resize());
    scroll.scrollTop = 490;
    fireEvent.scroll(scroll);
    act(() => resize());
    expect(scroll.scrollTop).toBe(500);
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });

  it("keeps the scroll floor at the settled content height", () => {
    const scroll = openThread();
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(1200);
    act(() => resize());
    const floor = scroll.querySelector<HTMLElement>("[data-conversation-scroll-floor]")!;
    expect(floor.style.height).toBe("1200px");

    // A small settle needs no easing, but must still release the floor.
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(1190);
    act(() => resize());
    expect(floor.style.height).toBe("1190px");
  });
});

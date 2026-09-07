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
});

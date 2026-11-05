import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { nextRevealLength, useStreamingText } from "@falcondeck/client-core";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function stubFrames() {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (handle: number) => {
    frames.delete(handle);
  });
  return () =>
    act(() => {
      vi.advanceTimersByTime(16);
      const pending = [...frames.values()];
      frames.clear();
      pending.forEach((callback) => callback(Date.now()));
    });
}

describe("paced streaming text", () => {
  const paced = { paced: true };

  it("spreads a burst across frames, only ever showing a prefix", () => {
    vi.useFakeTimers();
    const frame = stubFrames();
    const burst = "x".repeat(60);
    const { result, rerender } = renderHook(
      ({ text }) => useStreamingText(text, true, paced),
      { initialProps: { text: "" } },
    );
    rerender({ text: burst });
    expect(result.current).toBe("");
    const seen: number[] = [];
    for (let i = 0; i < 40 && result.current !== burst; i += 1) {
      frame();
      expect(burst.startsWith(result.current)).toBe(true);
      seen.push(result.current.length);
    }
    expect(result.current).toBe(burst);
    expect(seen.length).toBeGreaterThan(5);
    expect(seen[0]).toBeLessThan(burst.length / 2);
  });

  it("shows the full text immediately when the message completes", () => {
    vi.useFakeTimers();
    const frame = stubFrames();
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useStreamingText(text, streaming, paced),
      { initialProps: { text: "", streaming: true } },
    );
    rerender({ text: "a long burst of text", streaming: true });
    frame();
    rerender({ text: "a long burst of text, done", streaming: false });
    expect(result.current).toBe("a long burst of text, done");
    act(() => { vi.advanceTimersByTime(200); });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not stall when animation frames stop", () => {
    vi.useFakeTimers();
    stubFrames();
    const { result, rerender } = renderHook(
      ({ text }) => useStreamingText(text, true, paced),
      { initialProps: { text: "" } },
    );
    rerender({ text: "hidden window" });
    act(() => { vi.advanceTimersByTime(130); });
    expect(result.current).toBe("hidden window");
  });

  it("keeps publishing through steady chunks while frames are stopped", () => {
    vi.useFakeTimers();
    stubFrames();
    const { result, rerender } = renderHook(
      ({ text }) => useStreamingText(text, true, paced),
      { initialProps: { text: "" } },
    );
    let text = "";
    for (let i = 0; i < 6; i += 1) {
      text += "chunk ";
      rerender({ text });
      act(() => { vi.advanceTimersByTime(100); });
    }
    expect(result.current.length).toBeGreaterThanOrEqual("chunk ".length * 4);
  });

  it("paints bursts whole for reduced motion", () => {
    vi.useFakeTimers();
    stubFrames();
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const { result, rerender } = renderHook(
      ({ text }) => useStreamingText(text, true, paced),
      { initialProps: { text: "" } },
    );
    rerender({ text: "whole burst" });
    act(() => { vi.advanceTimersByTime(60); });
    expect(result.current).toBe("whole burst");
  });

  it("keeps up with the wire and never splits a surrogate pair", () => {
    const text = `${"a".repeat(9)}😀`;
    expect(nextRevealLength(text, 8, 16)).not.toBe(10);
    expect(nextRevealLength("x".repeat(180), 0, 16)).toBe(16);
    expect(nextRevealLength("abc", 3, 16)).toBe(3);
    expect(nextRevealLength("abcdef", 0, 1)).toBe(1);
  });
});

describe("streaming text cadence", () => {
  it("publishes the latest burst within 50ms even while chunks keep arriving", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ text }) => useStreamingText(text, true),
      { initialProps: { text: "a" } },
    );
    for (let i = 2; i <= 5; i++) {
      act(() => { vi.advanceTimersByTime(10); });
      rerender({ text: "a".repeat(i) });
      expect(result.current).toBe("a");
    }
    act(() => { vi.advanceTimersByTime(10); });
    expect(result.current).toBe("aaaaa");
  });

  it("flushes completion immediately and cancels the pending update", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ text, streaming }) => useStreamingText(text, streaming),
      { initialProps: { text: "a", streaming: true } },
    );
    rerender({ text: "ab", streaming: true });
    expect(result.current).toBe("a");
    rerender({ text: "abc", streaming: false });
    expect(result.current).toBe("abc");
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current).toBe("abc");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("shows replacements immediately and cancels timers on unmount", () => {
    vi.useFakeTimers();
    const { result, rerender, unmount } = renderHook(
      ({ text }) => useStreamingText(text, true),
      { initialProps: { text: "old" } },
    );
    rerender({ text: "old tail" });
    rerender({ text: "new" });
    expect(result.current).toBe("new");
    rerender({ text: "new tail" });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStreamingText } from "@falcondeck/client-core";

afterEach(() => vi.useRealTimers());

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

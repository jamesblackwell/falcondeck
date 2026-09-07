import React from "react";
import { act } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanup, renderComponent, textOf } from "@/test/render";
import { TranscriptRefreshPill } from "./TranscriptRefreshPill";

describe("TranscriptRefreshPill", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("waits before announcing a refresh and hides as soon as the page lands", () => {
    const renderer = renderComponent(<TranscriptRefreshPill visible />);
    // A warm cache that refreshes in under the grace period never flashes.
    expect(textOf(renderer)).not.toContain("Updating conversation");
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(textOf(renderer)).toContain("Updating conversation");

    act(() => {
      renderer.update(<TranscriptRefreshPill visible={false} />);
    });
    expect(textOf(renderer)).not.toContain("Updating conversation");
  });

  it("never shows when the load finishes inside the grace period", () => {
    const renderer = renderComponent(<TranscriptRefreshPill visible />);
    act(() => {
      vi.advanceTimersByTime(200);
      renderer.update(<TranscriptRefreshPill visible={false} />);
      vi.advanceTimersByTime(400);
    });
    expect(textOf(renderer)).not.toContain("Updating conversation");
  });
});

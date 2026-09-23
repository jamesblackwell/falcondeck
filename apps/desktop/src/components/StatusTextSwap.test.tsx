import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StatusTextSwap } from "@falcondeck/ui";

const STATUS_TEXT_SWAP_MS = 150;

function stubMatchMedia(matches: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("prefers-reduced-motion") ? matches : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
    onchange: null,
  })) as typeof window.matchMedia;
}

describe("StatusTextSwap", () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    vi.useRealTimers();
  });

  it("renders the current label on first paint without an outgoing copy", () => {
    render(<StatusTextSwap text="Thinking…" />);

    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(document.querySelector(".fd-status-text__out")).toBeNull();
  });

  it("swaps in place under reduced motion", () => {
    stubMatchMedia(true);
    const { rerender } = render(<StatusTextSwap text="Sending…" />);
    rerender(<StatusTextSwap text="Thinking…" />);

    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(screen.queryByText("Sending…")).not.toBeInTheDocument();
    expect(document.querySelector(".fd-status-text__out")).toBeNull();
  });

  it("keeps the current label accessible while the previous copy exits", () => {
    stubMatchMedia(false);
    vi.useFakeTimers();
    const { rerender } = render(<StatusTextSwap text="Sending…" />);

    rerender(<StatusTextSwap text="Thinking…" />);

    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(screen.queryByText("Sending…")).not.toBeInTheDocument();
    const outgoing = document.querySelector(".fd-status-text__out");
    expect(outgoing).toHaveAttribute("data-text", "Sending…");
    expect(outgoing).toHaveAttribute("aria-hidden", "true");

    act(() => {
      vi.advanceTimersByTime(STATUS_TEXT_SWAP_MS);
    });
    expect(document.querySelector(".fd-status-text__out")).toBeNull();
  });

  it("retargets the incoming label if a second swap arrives mid-animation", () => {
    stubMatchMedia(false);
    vi.useFakeTimers();
    const { rerender } = render(<StatusTextSwap text="Sending…" />);

    rerender(<StatusTextSwap text="Setting up isolated copy…" />);
    rerender(<StatusTextSwap text="Thinking…" />);

    expect(screen.getByText("Thinking…")).toBeInTheDocument();
    expect(document.querySelector(".fd-status-text__out")).toHaveAttribute(
      "data-text",
      "Sending…",
    );

    act(() => {
      vi.advanceTimersByTime(STATUS_TEXT_SWAP_MS);
    });
    expect(document.querySelector(".fd-status-text__out")).toBeNull();
    expect(screen.getByText("Thinking…")).toBeInTheDocument();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ComposerSuggestionOffer } from "@falcondeck/client-core";

import { ComposerSuggestionPill } from "./composer-suggestion-pill";

const SHIP = {
  id: "ship",
  label: "Ship it",
  description: "Open a pull request",
  prompt: "Open a pull request for this change.",
};
const TEST = { id: "test", label: "Run the tests", prompt: "Run the suite." };

const offer: ComposerSuggestionOffer = {
  extensionId: "falcondeck.follow-up-suggestions",
  primary: SHIP,
  actions: [SHIP, TEST],
  key: "falcondeck.follow-up-suggestions:1:ship,test",
};

describe("ComposerSuggestionPill", () => {
  it("renders nothing without an offer", () => {
    const { container } = render(
      <ComposerSuggestionPill offer={null} onSubmit={vi.fn()} onDismiss={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("submits the primary action from its own segment", () => {
    const onSubmit = vi.fn();
    render(
      <ComposerSuggestionPill offer={offer} onSubmit={onSubmit} onDismiss={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Ship it/ }));
    expect(onSubmit).toHaveBeenCalledWith(SHIP);
  });

  it("opens the alternatives behind the chevron and submits one", () => {
    const onSubmit = vi.fn();
    render(
      <ComposerSuggestionPill offer={offer} onSubmit={onSubmit} onDismiss={vi.fn()} />,
    );

    // Only the primary action is visible until the chevron is used, so the
    // pill stays one compact row.
    expect(screen.queryByText("Run the tests")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 1 more suggestion" }));
    fireEvent.click(screen.getByRole("button", { name: /Run the tests/ }));
    expect(onSubmit).toHaveBeenCalledWith(TEST);
  });

  it("hides the chevron when there is nothing behind it", () => {
    render(
      <ComposerSuggestionPill
        offer={{ ...offer, actions: [SHIP] }}
        onSubmit={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: /more suggestion/ })).toBeNull();
  });

  it("dismisses on request", () => {
    const onDismiss = vi.fn();
    render(
      <ComposerSuggestionPill offer={offer} onSubmit={vi.fn()} onDismiss={onDismiss} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Dismiss suggestions" }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("names every control for assistive technology", () => {
    render(
      <ComposerSuggestionPill offer={offer} onSubmit={vi.fn()} onDismiss={vi.fn()} />,
    );

    expect(screen.getByRole("group", { name: "Suggested next steps" })).toBeTruthy();
    for (const name of [
      /Ship it/,
      "Show 1 more suggestion",
      "Dismiss suggestions",
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
  });

  it("closes stale alternatives when a new turn replaces the offer", () => {
    const { rerender } = render(
      <ComposerSuggestionPill offer={offer} onSubmit={vi.fn()} onDismiss={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show 1 more suggestion" }));
    expect(screen.getByText("Run the tests")).toBeTruthy();

    const replacement: ComposerSuggestionOffer = {
      ...offer,
      actions: [SHIP, { id: "other", label: "Something else", prompt: "Do it." }],
      key: "falcondeck.follow-up-suggestions:2:ship,other",
    };
    rerender(
      <ComposerSuggestionPill offer={replacement} onSubmit={vi.fn()} onDismiss={vi.fn()} />,
    );

    expect(screen.queryByText("Run the tests")).toBeNull();
    expect(screen.queryByText("Something else")).toBeNull();
  });
});

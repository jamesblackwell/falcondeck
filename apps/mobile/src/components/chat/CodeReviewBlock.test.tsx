import * as Clipboard from "expo-clipboard";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import type {
  ContentLifecycle,
  ConversationItem,
} from "@falcondeck/client-core";

import { CodeReviewBlock } from "./CodeReviewBlock";

function review(
  lifecycle: ContentLifecycle,
  content = "",
): Extract<ConversationItem, { kind: "code_review" }> {
  return {
    kind: "code_review",
    id: "review-1",
    subject: "current changes",
    content,
    lifecycle,
    created_at: "2026-08-09T10:00:00Z",
  };
}

describe("CodeReviewBlock", () => {
  it("announces the active review target as busy", () => {
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<CodeReviewBlock item={review("streaming")} />);
    });

    expect(
      tree!.root.findByProps({
        accessibilityLabel:
          "Reviewing current changes. Inspecting the requested code and preparing findings.",
      }).props.accessibilityState,
    ).toEqual({ busy: true });
  });

  it("renders completed Markdown findings with a copy action", () => {
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <CodeReviewBlock
          item={review("complete", "## Findings\n\n- Fix the reconnect race.")}
        />,
      );
    });

    const rendered = JSON.stringify(tree!.toJSON());
    expect(rendered).toContain("Findings");
    expect(rendered).toContain("Fix the reconnect race.");
    expect(
      tree!.root.findByProps({ accessibilityLabel: "Copy code review" }),
    ).toBeDefined();
  });

  it("keeps provider directive-looking text literal in display and copy", async () => {
    const copy = vi.spyOn(Clipboard, "setStringAsync").mockResolvedValue(true);
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <CodeReviewBlock
          item={review(
            "complete",
            "## Findings\n\nReady.\n::future-review-action{state=ready provider-fragment}",
          )}
        />,
      );
    });

    await act(async () => {
      const copyButton = tree!.root
        .findAllByProps({ accessibilityLabel: "Copy code review" })
        .find((node) => typeof node.props.onPress === "function");
      expect(copyButton).toBeDefined();
      await copyButton!.props.onPress();
    });

    expect(JSON.stringify(tree!.toJSON())).toContain("::future-review-action");
    expect(copy).toHaveBeenCalledWith(
      "## Findings\n\nReady.\n::future-review-action{state=ready provider-fragment}",
    );
  });

  it("does not copy an unfinished action while review findings are streaming", async () => {
    const copy = vi.spyOn(Clipboard, "setStringAsync").mockResolvedValue(true);
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <CodeReviewBlock
          item={review(
            "streaming",
            "Partial finding.\n::future-review-action{state=run",
          )}
        />,
      );
    });

    await act(async () => {
      const copyButton = tree!.root
        .findAllByProps({ accessibilityLabel: "Copy code review" })
        .find((node) => typeof node.props.onPress === "function");
      expect(copyButton).toBeDefined();
      await copyButton!.props.onPress();
    });

    expect(copy).toHaveBeenCalledWith(
      "Partial finding.\n::future-review-action{state=run",
    );
  });

  it("keeps partial findings visible with assertive failure semantics", () => {
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <CodeReviewBlock item={review("error", "Partial finding")} />,
      );
    });

    const alert = tree!.root.findByProps({ accessibilityRole: "alert" });
    expect(alert.props.accessibilityLiveRegion).toBe("assertive");
    expect(JSON.stringify(tree!.toJSON())).toContain("Partial finding");
    expect(JSON.stringify(tree!.toJSON())).toContain("Review failed");
  });

  it("shows an interrupted receipt when no findings arrived", () => {
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<CodeReviewBlock item={review("interrupted")} />);
    });

    expect(
      tree!.root.findByProps({
        accessibilityLabel:
          "Code review interrupted. The review of current changes stopped before completion.",
      }),
    ).toBeDefined();
  });
});

import * as Clipboard from "expo-clipboard";
import { create, act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatInspectableValue,
  normalizeConversationItem,
} from "@falcondeck/client-core";

import { UnsupportedBlock } from "./UnsupportedBlock";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UnsupportedBlock", () => {
  it("renders and reveals a future output payload", () => {
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <UnsupportedBlock
          item={{ kind: "artifact_preview", url: "https://example.com" }}
        />,
      );
    });

    const button = tree!.root.findByProps({
      accessibilityLabel:
        "Unsupported output: artifact preview. Complete. This output is not supported.",
    });
    expect(JSON.stringify(tree!.toJSON())).not.toContain("https://example.com");
    expect(button.props.accessibilityHint).toBe("Shows technical details");
    act(() => button.props.onPress());
    expect(
      tree!.root.findByProps({
        accessibilityLabel:
          "Unsupported output: artifact preview. Complete. This output is not supported.",
      }).props.accessibilityHint,
    ).toBe("Hides technical details");

    expect(tree!.toJSON()).toEqual(expect.objectContaining({ type: "View" }));
    expect(JSON.stringify(tree!.toJSON())).toContain("https://example.com");
  });

  it("bounds adversarial future payloads and discloses the display limit", () => {
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <UnsupportedBlock
          item={{ kind: "future_trace", payload: "x".repeat(25_000) }}
        />,
      );
    });

    const button = tree!.root.findByProps({
      accessibilityLabel:
        "Unsupported output: future trace. Complete. This output is not supported.",
    });
    act(() => button.props.onPress());

    const rendered = JSON.stringify(tree!.toJSON());
    expect(rendered).toContain("characters omitted");
    expect(rendered).toContain("Display limited for performance and safety.");
    expect(rendered.length).toBeLessThan(24_000);
  });

  it("keeps the complete formatted inspection behind the copy action", async () => {
    const payload = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [
        `field_${index}`,
        `value_${index}`,
      ]),
    );
    const item = { kind: "future_trace", payload };
    const inspection = formatInspectableValue(item).text;
    const copy = vi.spyOn(Clipboard, "setStringAsync").mockResolvedValue(true);
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<UnsupportedBlock item={item} />);
    });

    act(() =>
      tree!.root
        .findByProps({
          accessibilityLabel:
            "Unsupported output: future trace. Complete. This output is not supported.",
        })
        .props.onPress(),
    );
    expect(
      tree!.root.findAll(
        (node) =>
          typeof node.props.accessibilityLabel === "string" &&
          node.props.accessibilityLabel.startsWith("Show ") &&
          node.props.accessibilityLabel.endsWith(" more lines"),
      ),
    ).toHaveLength(1);
    await act(async () => {
      await tree!.root
        .findByProps({ accessibilityLabel: "Copy code" })
        .props.onPress();
    });
    expect(copy).toHaveBeenCalledWith(inspection);
  });

  it("routes malformed known output to the fallback without losing evidence", () => {
    const item = normalizeConversationItem({
      kind: "assistant_message",
      id: "broken-assistant",
      text: { unexpected: "structured text" },
    });
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<UnsupportedBlock item={item} />);
    });

    const button = tree!.root.findByProps({
      accessibilityLabel:
        "Unsupported output: assistant message. Complete. Malformed conversation output",
    });
    act(() => button.props.onPress());
    expect(JSON.stringify(tree!.toJSON())).toContain("structured text");
  });

  it("announces lifecycle and inspects only the bounded provider payload", () => {
    const item = normalizeConversationItem({
      kind: "unsupported",
      id: "future-1",
      output_kind: "artifactPreview",
      reason: "Provider output is not supported by this FalconDeck version",
      payload: { title: "Prototype" },
      lifecycle: "streaming",
      created_at: "2026-08-09T10:00:00Z",
    });
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(<UnsupportedBlock item={item} />);
    });

    const button = tree!.root.findByProps({
      accessibilityLabel:
        "Unsupported output: artifact preview. Streaming. Provider output is not supported by this FalconDeck version",
    });
    act(() => button.props.onPress());
    expect(
      tree!.root
        .findAllByType("Text" as any)
        .some(
          (node) =>
            node.props.selectable === true &&
            node.children.includes(
              "Provider output is not supported by this FalconDeck version",
            ),
        ),
    ).toBe(true);
    const rendered = JSON.stringify(tree!.toJSON());
    expect(rendered).toContain("Prototype");
    expect(rendered).not.toContain("created_at");
  });
});

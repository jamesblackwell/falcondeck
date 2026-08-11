import * as Clipboard from "expo-clipboard";
import { create, act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import { formatInspectableValue } from "@falcondeck/client-core";

import { RealtimeEventBlock } from "./RealtimeEventBlock";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RealtimeEventBlock", () => {
  it("labels and reveals an unstable provider item accessibly", () => {
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <RealtimeEventBlock
          item={{
            kind: "realtime",
            id: "handoff-1",
            item_type: "handoff_request",
            title: "Voice handoff requested",
            summary: "Continue in Codex.",
            payload: { type: "handoff_request", destination: "codex" },
            created_at: "2026-08-09T10:00:00Z",
          }}
        />,
      );
    });

    const button = tree!.root.findByProps({
      accessibilityLabel: "Voice handoff requested",
    });
    expect(button.props.accessibilityState).toEqual({ expanded: false });
    expect(JSON.stringify(tree!.toJSON())).not.toContain("destination");
    act(() => button.props.onPress());
    expect(JSON.stringify(tree!.toJSON())).toContain("destination");
  });

  it("bounds and copies the complete formatted provider inspection", async () => {
    const payload = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [
        `field_${index}`,
        `value_${index}`,
      ]),
    );
    const inspection = formatInspectableValue(payload).text;
    const copy = vi.spyOn(Clipboard, "setStringAsync").mockResolvedValue(true);
    let tree: ReturnType<typeof create>;
    act(() => {
      tree = create(
        <RealtimeEventBlock
          item={{
            kind: "realtime",
            id: "handoff-large",
            item_type: "handoff_request",
            title: "Voice handoff requested",
            summary: "Continue in Codex.",
            payload,
            created_at: "2026-08-09T10:00:00Z",
          }}
        />,
      );
    });

    act(() =>
      tree!.root
        .findByProps({ accessibilityLabel: "Voice handoff requested" })
        .props.onPress(),
    );
    expect(
      tree!.root.findByProps({ accessibilityLabel: "Show 18 more lines" }),
    ).toBeDefined();
    await act(async () => {
      await tree!.root
        .findByProps({ accessibilityLabel: "Copy code" })
        .props.onPress();
    });
    expect(copy).toHaveBeenCalledWith(inspection);
  });
});

import React from "react";
import { Linking } from "react-native";
import { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ContentLifecycle,
  ConversationItem,
} from "@falcondeck/client-core";

import { cleanup, renderComponent, textOf } from "@/test/render";
import { ImageOutputBlock } from "./ImageOutputBlock";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function imageItem(
  lifecycle: ContentLifecycle,
  url = "https://example.com/falcon.png",
) {
  return {
    kind: "image",
    id: `image-${lifecycle}`,
    title: "Generated image",
    image: {
      id: `image-${lifecycle}-asset`,
      name: "falcon.png",
      mime_type: "image/png",
      url,
      local_path: null,
      alt_text: "A falcon over a control deck",
    },
    lifecycle,
    created_at: "2026-08-08T20:00:00Z",
  } satisfies Extract<ConversationItem, { kind: "image" }>;
}

describe("ImageOutputBlock", () => {
  it("previews a remote image in-app and keeps external opening explicit", async () => {
    const openUrl = vi.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    const renderer = renderComponent(
      <ImageOutputBlock item={imageItem("complete")} />,
    );
    const image = renderer.root.findAllByType("ExpoImage" as never)[0];
    expect(image.props.recyclingKey).toBe("https://example.com/falcon.png");
    const modal = () => renderer.root.findByType("Modal" as never);
    expect(modal().props.visible).toBe(false);

    act(() =>
      renderer.root
        .findByProps({
          accessibilityLabel: "Preview A falcon over a control deck",
        })
        .props.onPress(),
    );
    expect(modal().props.visible).toBe(true);
    expect(
      renderer.root.findByProps({ accessibilityLabel: "Close image preview" }),
    ).toBeDefined();

    const link = renderer.root.findByProps({
      accessibilityLabel: "Open original image",
    });
    await act(async () => {
      link.props.onPress();
      await Promise.resolve();
    });
    expect(openUrl).toHaveBeenCalledWith("https://example.com/falcon.png");
  });

  it("previews safe inline images without offering an external-open action", () => {
    const renderer = renderComponent(
      <ImageOutputBlock
        item={imageItem("complete", "data:image/png;base64,AAAA")}
      />,
    );

    act(() =>
      renderer.root
        .findByProps({
          accessibilityLabel: "Preview A falcon over a control deck",
        })
        .props.onPress(),
    );
    expect(renderer.root.findByType("Modal" as never).props.visible).toBe(true);
    expect(
      renderer.root.findAllByProps({
        accessibilityLabel: "Open original image",
      }),
    ).toHaveLength(0);
  });

  it("keeps an external-open failure visible and retryable", async () => {
    const openUrl = vi
      .spyOn(Linking, "openURL")
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue(undefined);
    const renderer = renderComponent(
      <ImageOutputBlock item={imageItem("complete")} />,
    );
    const link = renderer.root.findByProps({
      accessibilityLabel: "Open original image",
    });

    await act(async () => {
      link.props.onPress();
      await Promise.resolve();
    });

    expect(
      renderer.root.findByProps({
        accessibilityLabel: "Could not open the original image. Try again.",
      }),
    ).toBeDefined();
    expect(link.props.accessibilityHint).toBe(
      "Retries opening the original image outside FalconDeck",
    );

    await act(async () => {
      await link.props.onPress();
    });
    expect(openUrl).toHaveBeenCalledTimes(2);
    expect(
      renderer.root.findAllByProps({
        accessibilityLabel: "Could not open the original image. Try again.",
      }),
    ).toHaveLength(0);
  });

  it("shows explicit transient and failed states", () => {
    const streaming = renderComponent(
      <ImageOutputBlock item={imageItem("streaming", "")} />,
    );
    const failed = renderComponent(
      <ImageOutputBlock item={imageItem("error", "")} />,
    );
    expect(textOf(streaming)).toContain("Generating image…");
    expect(
      streaming.root.findByProps({ accessibilityLabel: "Generating image" }),
    ).toBeDefined();
    expect(textOf(failed)).toContain("Image unavailable");
    const unavailable = failed.root.findByProps({
      accessibilityLabel: "Image unavailable",
    });
    expect(unavailable.props.accessibilityRole).toBe("alert");
    expect(unavailable.props.accessibilityLiveRegion).toBe("assertive");

    const failedMedia = unavailable.parent;
    expect(failedMedia?.props.style).toContainEqual(
      expect.objectContaining({ minHeight: 96 }),
    );
    expect(failedMedia?.props.style).not.toContainEqual(
      expect.objectContaining({ aspectRatio: 4 / 3 }),
    );
  });

  it("surfaces image load failures instead of leaving a broken frame", () => {
    const renderer = renderComponent(
      <ImageOutputBlock item={imageItem("complete")} />,
    );
    act(() => renderer.root.findByType("ExpoImage" as never).props.onError());
    expect(textOf(renderer)).toContain("Image unavailable");
  });

  it("never passes an executable provider URL to the native image decoder", () => {
    const renderer = renderComponent(
      <ImageOutputBlock item={imageItem("complete", "javascript:alert(1)")} />,
    );

    expect(renderer.root.findAllByType("ExpoImage" as never)).toHaveLength(0);
    expect(textOf(renderer)).toContain("Image unavailable");
  });

  it("rejects credential-bearing remote images without offering an OS handoff", () => {
    const renderer = renderComponent(
      <ImageOutputBlock
        item={imageItem(
          "complete",
          "https://user:secret@example.com/falcon.png",
        )}
      />,
    );

    expect(renderer.root.findAllByType("ExpoImage" as never)).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({
        accessibilityLabel: "Open original image",
      }),
    ).toHaveLength(0);
    expect(textOf(renderer)).toContain("Image unavailable");
  });

  it("preserves a usable image when the generation later reports an error", () => {
    const renderer = renderComponent(
      <ImageOutputBlock item={imageItem("error")} />,
    );
    expect(renderer.root.findByType("ExpoImage" as never)).toBeDefined();
    expect(textOf(renderer)).toContain("Failed");
  });
});

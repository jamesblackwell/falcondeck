import React from "react";
import { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ImageInput } from "@falcondeck/client-core";

import { cleanup, renderComponent, textOf } from "@/test/render";
import { AttachmentPreviewList } from "./AttachmentPreviewList";

afterEach(cleanup);

const attachment = {
  type: "image",
  id: "reference-image",
  name: "reference.png",
  mime_type: "image/png",
  url: "file:///private/tmp/reference.png",
  local_path: "/private/tmp/reference.png",
} satisfies ImageInput;

describe("AttachmentPreviewList", () => {
  it("opens and closes a full-screen preview for safe picker images", () => {
    const renderer = renderComponent(
      <AttachmentPreviewList attachments={[attachment]} />,
    );
    const modal = () => renderer.root.findByType("Modal" as never);
    expect(modal().props.visible).toBe(false);

    act(() =>
      renderer.root
        .findByProps({ accessibilityLabel: "Preview reference.png" })
        .props.onPress(),
    );
    expect(modal().props.visible).toBe(true);
    expect(
      renderer.root.findByProps({ accessibilityLabel: "Close image preview" }),
    ).toBeDefined();

    act(() =>
      renderer.root
        .findByProps({ accessibilityLabel: "Close image preview" })
        .props.onPress(),
    );
    expect(modal().props.visible).toBe(false);
  });

  it("keeps an open preview aligned with an authoritative attachment replacement", () => {
    const renderer = renderComponent(
      <AttachmentPreviewList attachments={[attachment]} />,
    );
    act(() =>
      renderer.root
        .findByProps({ accessibilityLabel: "Preview reference.png" })
        .props.onPress(),
    );

    const replacement = {
      ...attachment,
      name: "updated-reference.png",
      url: "file:///private/tmp/updated-reference.png",
      local_path: "/private/tmp/updated-reference.png",
    };
    act(() => {
      renderer.update(<AttachmentPreviewList attachments={[replacement]} />);
    });

    const images = renderer.root.findAllByType("ExpoImage" as never);
    expect(images.at(-1)?.props.source).toEqual({
      uri: "file:///private/tmp/updated-reference.png",
    });
    expect(
      renderer.root.findByProps({
        accessibilityLabel: "updated-reference.png",
      }),
    ).toBeDefined();
  });

  it("closes a removed preview without resurrecting it when the id returns", () => {
    const renderer = renderComponent(
      <AttachmentPreviewList attachments={[attachment]} />,
    );
    act(() =>
      renderer.root
        .findByProps({ accessibilityLabel: "Preview reference.png" })
        .props.onPress(),
    );
    expect(renderer.root.findByType("Modal" as never).props.visible).toBe(true);

    act(() => {
      renderer.update(<AttachmentPreviewList attachments={[]} />);
    });
    act(() => {
      renderer.update(<AttachmentPreviewList attachments={[attachment]} />);
    });

    expect(renderer.root.findByType("Modal" as never).props.visible).toBe(
      false,
    );
  });

  it("surfaces decode failures instead of leaving a broken thumbnail", () => {
    const renderer = renderComponent(
      <AttachmentPreviewList attachments={[attachment]} />,
    );
    act(() => renderer.root.findByType("ExpoImage" as never).props.onError());

    expect(textOf(renderer)).toContain("Unavailable");
    expect(
      renderer.root.findByProps({
        accessibilityLabel: "reference.png, image unavailable",
      }),
    ).toBeDefined();
  });

  it("surfaces a full-screen decode failure while preserving dismissal", () => {
    const renderer = renderComponent(
      <AttachmentPreviewList attachments={[attachment]} />,
    );
    act(() =>
      renderer.root
        .findByProps({ accessibilityLabel: "Preview reference.png" })
        .props.onPress(),
    );

    const images = renderer.root.findAllByType("ExpoImage" as never);
    act(() => images.at(-1)?.props.onError());

    expect(textOf(renderer)).toContain("Image unavailable");
    expect(
      renderer.root.findByProps({
        accessibilityLabel: "reference.png, image unavailable",
      }),
    ).toBeDefined();
    expect(
      renderer.root.findByProps({ accessibilityLabel: "Close image preview" }),
    ).toBeDefined();
  });

  it("rejects executable image schemes while preserving remove controls", () => {
    const remove = vi.fn();
    const renderer = renderComponent(
      <AttachmentPreviewList
        attachments={[{ ...attachment, url: "javascript:alert(1)" }]}
        onRemoveAttachment={remove}
      />,
    );

    expect(textOf(renderer)).toContain("Unavailable");
    expect(renderer.root.findAllByType("ExpoImage" as never)).toHaveLength(0);
    act(() =>
      renderer.root
        .findByProps({ accessibilityLabel: "Remove reference.png" })
        .props.onPress(),
    );
    expect(remove).toHaveBeenCalledWith("reference-image");
  });

  it("derives an unnamed remote image label without exposing its query string", () => {
    const renderer = renderComponent(
      <AttachmentPreviewList
        attachments={[
          {
            ...attachment,
            name: null,
            local_path: null,
            url: "https://example.com/reference%20image.png?token=secret",
          },
        ]}
      />,
    );

    expect(textOf(renderer)).toContain("reference image.png");
    expect(textOf(renderer)).not.toContain("token=secret");
    expect(
      renderer.root.findByProps({
        accessibilityLabel: "Preview reference image.png",
      }),
    ).toBeDefined();
  });
});

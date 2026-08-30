import React from "react";
import { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Sharing from "expo-sharing";

import { cleanup, renderComponent } from "@/test/render";
import { resetFileSystemMock } from "@/test/__mocks__/expo-file-system";
import { resetSharingMock } from "@/test/__mocks__/expo-sharing";

import { ArtifactShareButton } from "./ArtifactShareButton";

afterEach(() => {
  cleanup();
  resetFileSystemMock();
  resetSharingMock();
  vi.restoreAllMocks();
});

describe("ArtifactShareButton", () => {
  it("coalesces repeated share taps while the native sheet is pending", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    const share = vi.spyOn(Sharing, "shareAsync").mockReturnValue(pending);
    const renderer = renderComponent(
      <ArtifactShareButton
        filename="report.md"
        mimeType="text/markdown"
        text="Report"
      />,
    );
    const button = renderer.root.findByProps({ accessibilityLabel: "Share report.md" });

    act(() => {
      button.props.onPress();
      button.props.onPress();
    });

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(share).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve();
      await pending;
    });
  });
});

import React from "react";
import { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fileSystemEvents,
  resetFileSystemMock,
} from "@/test/__mocks__/expo-file-system";
import {
  resetSharingMock,
  setSharingAvailable,
  sharingCalls,
} from "@/test/__mocks__/expo-sharing";
import { cleanup, renderComponent } from "../../test/render";
import { ConversationShareButton } from "./ConversationShareButton";

afterEach(() => {
  cleanup();
  resetFileSystemMock();
  resetSharingMock();
});

const items = [
  {
    kind: "user_message" as const,
    id: "user-1",
    text: "Run the checks.",
    attachments: [],
    created_at: "2026-08-10T12:00:00Z",
  },
];

describe("ConversationShareButton", () => {
  it("shares a deterministic Markdown snapshot and removes its temporary file", async () => {
    const renderer = renderComponent(
      <ConversationShareButton items={items} title="Release audit" partial />,
    );
    const button = renderer.root.findByProps({
      accessibilityLabel:
        "Share loaded conversation as Markdown. Earlier messages are not loaded.",
    });

    await act(async () => {
      button.props.onPress();
    });

    expect(sharingCalls[0]?.url).toMatch(/\/Release-audit\.md$/);
    expect(sharingCalls[0]?.options).toEqual({
      dialogTitle: "Share Release-audit.md",
      mimeType: "text/markdown",
    });
    const write = fileSystemEvents.find((event) => event.type === "write");
    expect(write?.value).toMatchObject({
      content: expect.stringContaining(
        "Earlier authoritative history is not currently loaded",
      ),
    });
    expect(fileSystemEvents.at(-1)?.type).toBe("directory-delete");
  });

  it("reports platform share failures and restores the action", async () => {
    setSharingAvailable(false);
    const onError = vi.fn();
    const renderer = renderComponent(
      <ConversationShareButton
        items={items}
        title="Release audit"
        partial={false}
        onError={onError}
      />,
    );
    const button = renderer.root.findByProps({
      accessibilityLabel: "Share conversation as Markdown",
    });

    await act(async () => {
      button.props.onPress();
    });

    expect(onError).toHaveBeenCalledWith(
      "Sharing is unavailable on this device.",
    );
    expect(button.props.accessibilityState).toEqual({
      busy: false,
      disabled: false,
    });
  });
});

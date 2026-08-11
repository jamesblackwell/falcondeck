import * as Clipboard from "expo-clipboard";
import { Linking } from "react-native";
import { act } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  formatInspectableValue,
  type ConversationItem,
} from "@falcondeck/client-core";

import { cleanup, renderComponent, textOf } from "@/test/render";
import { resetFileSystemMock } from "@/test/__mocks__/expo-file-system";
import { resetSharingMock, sharingCalls } from "@/test/__mocks__/expo-sharing";
import { ArtifactBlock } from "./ArtifactBlock";

function artifact(
  overrides: Partial<Extract<ConversationItem, { kind: "artifact" }>> = {},
): Extract<ConversationItem, { kind: "artifact" }> {
  return {
    kind: "artifact",
    id: "artifact-1",
    artifact: {
      title: "release-report.json",
      artifact_kind: "report",
      url: "https://example.com/artifacts/release-report",
      mime_type: "application/json",
      version: "v4",
      content: '{"checks":42,"status":"ready"}',
      payload: { checks: 42, status: "ready" },
    },
    lifecycle: "complete",
    created_at: "2026-08-09T12:00:00Z",
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  resetFileSystemMock();
  resetSharingMock();
  vi.restoreAllMocks();
});

describe("ArtifactBlock", () => {
  it("renders a typed selectable preview and opens safe URLs", async () => {
    const openUrl = vi.spyOn(Linking, "openURL").mockResolvedValue(undefined);
    const renderer = renderComponent(<ArtifactBlock item={artifact()} />);

    expect(textOf(renderer)).toContain("release-report.json");
    expect(textOf(renderer)).toContain(
      "report · application/json · Version v4 · Complete",
    );
    expect(textOf(renderer)).toContain('{"checks":42,"status":"ready"}');
    const open = renderer.root.findByProps({
      accessibilityLabel: "Open artifact: release-report.json",
    });
    expect(open.props.accessibilityRole).toBe("link");
    const share = renderer.root.findByProps({
      accessibilityLabel: "Share release-report.json",
    });

    await act(async () => {
      await open.props.onPress();
    });
    expect(openUrl).toHaveBeenCalledWith(
      "https://example.com/artifacts/release-report",
    );
    await act(async () => {
      await share.props.onPress();
    });
    expect(sharingCalls[0]?.options).toEqual({
      dialogTitle: "Share release-report.json",
      mimeType: "application/json",
    });
  });

  it("does not offer a half-streamed artifact for sharing", () => {
    const renderer = renderComponent(
      <ArtifactBlock item={artifact({ lifecycle: "streaming" })} />,
    );

    expect(
      renderer.root.findAllByProps({
        accessibilityLabel: "Share release-report.json",
      }),
    ).toHaveLength(0);
  });

  it("keeps unsafe provider references readable but inert", () => {
    const renderer = renderComponent(
      <ArtifactBlock
        item={artifact({
          artifact: {
            ...artifact().artifact,
            url: "asset://prototype",
            content: null,
          },
        })}
      />,
    );

    expect(textOf(renderer)).toContain("Reference: asset://prototype");
    expect(textOf(renderer)).toContain("without an inline preview");
    expect(
      renderer.root.findAllByProps({
        accessibilityLabel: "Open artifact: release-report.json",
      }),
    ).toHaveLength(0);
  });

  it("retains failed provider evidence in bounded technical details", () => {
    const renderer = renderComponent(
      <ArtifactBlock
        item={artifact({
          lifecycle: "error",
          artifact: {
            ...artifact().artifact,
            content: null,
            payload: { error: "Provider stream ended unexpectedly" },
          },
        })}
      />,
    );

    const details = renderer.root.findByProps({
      accessibilityLabel: "Artifact technical details",
    });
    expect(textOf(renderer)).not.toContain(
      "Provider stream ended unexpectedly",
    );
    act(() => details.props.onPress());

    expect(textOf(renderer)).toContain("Provider stream ended unexpectedly");
    expect(
      renderer.root.findByProps({
        accessibilityLabel: "release-report.json. Artifact. Failed",
      }).props.accessibilityState,
    ).toEqual({ busy: false });
  });

  it("previews and copies the complete formatted artifact payload", async () => {
    const payload = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [
        `field_${index}`,
        `value_${index}`,
      ]),
    );
    const inspection = formatInspectableValue(payload).text;
    const copy = vi.spyOn(Clipboard, "setStringAsync").mockResolvedValue(true);
    const renderer = renderComponent(
      <ArtifactBlock
        item={artifact({
          artifact: { ...artifact().artifact, payload },
        })}
      />,
    );

    act(() =>
      renderer.root
        .findByProps({ accessibilityLabel: "Artifact technical details" })
        .props.onPress(),
    );
    expect(
      renderer.root.findByProps({ accessibilityLabel: "Show 18 more lines" }),
    ).toBeDefined();
    await act(async () => {
      await renderer.root
        .findAllByProps({ accessibilityLabel: "Copy code" })
        .at(-1)
        ?.props.onPress();
    });
    expect(copy).toHaveBeenCalledWith(inspection);
  });

  it("keeps provider markdown directives literal instead of spoofing agent actions", () => {
    const renderer = renderComponent(
      <ArtifactBlock
        item={artifact({
          artifact: {
            ...artifact().artifact,
            title: "provider-notes.md",
            mime_type: "text/markdown",
            content:
              'Provider evidence:\n\n::git-commit{cwd="/tmp/provider" commit="fake"}',
          },
        })}
      />,
    );

    expect(textOf(renderer)).toContain("::git-commit");
    expect(textOf(renderer)).not.toContain("cwd: provider");
  });
});

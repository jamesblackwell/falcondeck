import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { MessageCard } from "@falcondeck/chat-ui";
import type { ConversationItem } from "@falcondeck/client-core";

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

describe("artifact conversation output", () => {
  it("renders a typed preview and safe open action", () => {
    render(<MessageCard item={artifact()} />);

    expect(
      screen.getByRole("group", {
        name: "release-report.json. Artifact. Complete",
      }),
    ).toBeVisible();
    expect(
      screen.getByText("report · application/json · Version v4"),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Open artifact: release-report.json" }),
    ).toHaveAttribute("href", "https://example.com/artifacts/release-report");
    const download = screen.getByRole("link", {
      name: "Download artifact: release-report.json",
    });
    expect(download).toHaveAttribute("download", "release-report.json");
    expect(download).toHaveAttribute(
      "href",
      expect.stringMatching(/^data:application\/json;charset=utf-8,/),
    );
    const technicalDetails = screen
      .getByText("Technical details")
      .closest("details")!;
    expect(within(technicalDetails).queryByText(/"checks": 42/)).toBeNull();
    expect(technicalDetails).not.toHaveAttribute("open");
    fireEvent.click(screen.getByText("Technical details"));
    expect(within(technicalDetails).getByText(/"checks": 42/)).toBeVisible();
  });

  it("does not offer a half-streamed artifact for download", () => {
    render(<MessageCard item={artifact({ lifecycle: "streaming" })} />);

    expect(
      screen.queryByRole("link", { name: /Download artifact/ }),
    ).not.toBeInTheDocument();
  });

  it("falls back to a safe text MIME type for provider-authored download metadata", () => {
    render(
      <MessageCard
        item={artifact({
          artifact: {
            ...artifact().artifact,
            mime_type: "text/html\r\nContent-Disposition: inline",
          },
        })}
      />,
    );

    expect(
      screen.getByRole("link", {
        name: "Download artifact: release-report.json",
      }),
    ).toHaveAttribute(
      "href",
      expect.stringMatching(/^data:text\/plain;charset=utf-8,/),
    );
  });

  it("uses a portable filename for provider-authored download metadata", () => {
    render(
      <MessageCard
        item={artifact({
          artifact: {
            ...artifact().artifact,
            title: "../../Quarterly report?.json",
          },
        })}
      />,
    );

    expect(
      screen.getByRole("link", {
        name: "Download artifact: ../../Quarterly report?.json",
      }),
    ).toHaveAttribute("download", "Quarterly-report-.json");
  });

  it("keeps unsafe provider references readable but inert", () => {
    render(
      <MessageCard
        item={artifact({
          artifact: {
            ...artifact().artifact,
            url: "asset://prototype",
            content: null,
          },
        })}
      />,
    );

    expect(
      screen.queryByRole("link", { name: /Open artifact/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Reference: asset://prototype")).toBeVisible();
    expect(screen.getByText(/without an inline preview/)).toBeVisible();
  });

  it("retains failed artifact evidence behind technical details", () => {
    render(
      <MessageCard
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

    expect(screen.getByRole("alert")).toHaveTextContent("Failed");
    fireEvent.click(screen.getByText("Technical details"));
    expect(
      screen.getByText(/Provider stream ended unexpectedly/),
    ).toBeVisible();
  });

  it("bounds large technical payloads behind an explicit copy surface", () => {
    const payload = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [
        `field_${index}`,
        `value_${index}`,
      ]),
    );
    render(
      <MessageCard
        item={artifact({
          artifact: { ...artifact().artifact, payload },
        })}
      />,
    );

    const technicalDetails = screen
      .getByText("Technical details")
      .closest("details")!;
    fireEvent.click(screen.getByText("Technical details"));
    expect(within(technicalDetails).getByText("json")).toBeVisible();
    expect(
      within(technicalDetails).getByRole("button", { name: "Copy" }),
    ).toBeVisible();
    expect(
      within(technicalDetails).getByRole("button", {
        name: "Show 18 more lines",
      }),
    ).toBeVisible();
  });

  it("keeps provider markdown directives literal instead of spoofing agent actions", () => {
    render(
      <MessageCard
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

    expect(screen.getByText(/::git-commit/)).toBeVisible();
    expect(screen.queryByText("git commit")).not.toBeInTheDocument();
  });
});

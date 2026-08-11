import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MessageCard } from "@falcondeck/chat-ui";
import type { ConversationItem, ToolCallDetail } from "@falcondeck/client-core";

function stubClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

function tool(
  id: string,
  title: string,
  detail: ToolCallDetail,
): Extract<ConversationItem, { kind: "tool_call" }> {
  return {
    kind: "tool_call",
    id,
    title,
    tool_kind: detail.kind,
    status: "completed",
    output: null,
    exit_code: null,
    display: {
      is_read_only: true,
      has_side_effect: false,
      is_error: false,
      lifecycle: "succeeded",
      artifact_kind: "none",
      activity_kind: "other",
      history_mode: "full",
      summary_hint: null,
    },
    detail,
    created_at: "2026-08-09T10:00:00Z",
    completed_at: "2026-08-09T10:00:01Z",
  };
}

describe("provider-native tool output", () => {
  it("defers rich MCP payload parsing until the collapsed card is expanded", () => {
    let contentReads = 0;
    let iconReads = 0;
    const result = {
      get content() {
        contentReads += 1;
        return [
          {
            type: "resource_link",
            uri: "https://example.com/reference",
            name: "Reference",
            get icons() {
              iconReads += 1;
              return [{ src: "https://example.com/icon.png" }];
            },
          },
        ];
      },
    };
    const item = tool("mcp-lazy-result", "Provider · Search", {
      kind: "mcp",
      server: "provider",
      tool: "search",
      arguments: {},
      result,
      error: null,
      duration_ms: 12,
      app_context: null,
    });
    item.display.provider_output_summary = {
      text_blocks: 0,
      images: 0,
      audio: 0,
      resource_links: 1,
      embedded_resources: 0,
      structured_results: 0,
    };
    render(<MessageCard item={item} />);

    expect(screen.getByText("1 artifact")).toBeVisible();
    expect(contentReads).toBe(0);
    expect(iconReads).toBe(0);
    fireEvent.click(
      screen.getByRole("button", {
        name: /Provider · Search details, Completed$/,
      }),
    );
    expect(
      screen.getByLabelText("Provider reference: Reference"),
    ).toBeVisible();
    expect(contentReads).toBeGreaterThan(0);
    expect(iconReads).toBeGreaterThan(0);
  });

  it("bounds structured arguments behind expansion and copy controls", () => {
    const argumentsValue = Object.fromEntries(
      Array.from({ length: 24 }, (_, index) => [
        `field_${index}`,
        `value_${index}`,
      ]),
    );
    render(
      <MessageCard
        item={tool("mcp-arguments-large", "Provider · Inspect", {
          kind: "mcp",
          server: "provider",
          tool: "inspect",
          arguments: argumentsValue,
          result: null,
          error: null,
          duration_ms: 12,
          app_context: null,
        })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /Provider · Inspect details, Completed$/,
      }),
    );
    const argumentsDisclosure = screen.getByRole("button", {
      name: "Show arguments, 24 fields",
    });
    expect(argumentsDisclosure).toBeVisible();
    expect(screen.queryByText(/"field_0": "value_0"/)).not.toBeInTheDocument();
    fireEvent.click(argumentsDisclosure);
    expect(
      screen.getByRole("button", { name: "Hide arguments, 24 fields" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Copy" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Show 14 more lines" }),
    ).toBeVisible();
    expect(
      screen.queryByText(/"field_23": "value_23"/),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show 14 more lines" }));
    expect(screen.getByText(/"field_23": "value_23"/)).toBeVisible();
  });

  it("bounds and copies the complete MCP text result", async () => {
    const resultText = Array.from(
      { length: 30 },
      (_, index) => `Provider result ${index + 1}: retained evidence`,
    ).join("\n");
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(
      <MessageCard
        item={tool("mcp-text-large", "Provider · Search", {
          kind: "mcp",
          server: "provider",
          tool: "search",
          arguments: {},
          result: { content: [{ type: "text", text: resultText }] },
          error: null,
          duration_ms: 12,
          app_context: null,
        })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /Provider · Search details, Completed$/,
      }),
    );
    const disclosure = screen.getByRole("button", {
      name: "Show 18 more lines",
    });
    const resultCode = screen.getByText(
      (_, element) =>
        element?.tagName === "CODE" &&
        element.textContent?.includes(
          "Provider result 12: retained evidence",
        ) === true,
    );
    const resultBlock = resultCode.closest(".overflow-hidden");

    expect(resultBlock).not.toBeNull();
    expect(resultCode).not.toHaveTextContent(
      "Provider result 30: retained evidence",
    );
    fireEvent.click(
      within(resultBlock as HTMLElement).getByRole("button", { name: "Copy" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(resultText));
    fireEvent.click(disclosure);
    expect(resultCode).toHaveTextContent(
      "Provider result 30: retained evidence",
    );
  });

  it("bounds and copies the complete dynamic-tool text result", async () => {
    const resultText = Array.from(
      { length: 30 },
      (_, index) => `Rendered layer ${index + 1}: retained evidence`,
    ).join("\n");
    const writeText = vi.fn().mockResolvedValue(undefined);
    stubClipboard(writeText);
    render(
      <MessageCard
        item={tool("dynamic-text-large", "design · render", {
          kind: "dynamic",
          tool: "render",
          namespace: "design",
          arguments: {},
          content_items: [{ kind: "text", text: resultText }],
          success: true,
          duration_ms: 12,
        })}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /design · render details, Completed$/,
      }),
    );
    const disclosure = screen.getByRole("button", {
      name: "Show 18 more lines",
    });
    const resultCode = screen.getByText(
      (_, element) =>
        element?.tagName === "CODE" &&
        element.textContent?.includes(
          "Rendered layer 12: retained evidence",
        ) === true,
    );
    const resultBlock = resultCode.closest(".overflow-hidden");

    expect(resultBlock).not.toBeNull();
    expect(resultCode).not.toHaveTextContent(
      "Rendered layer 30: retained evidence",
    );
    fireEvent.click(
      within(resultBlock as HTMLElement).getByRole("button", { name: "Copy" }),
    );
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(resultText));
    fireEvent.click(disclosure);
    expect(resultCode).toHaveTextContent(
      "Rendered layer 30: retained evidence",
    );
  });

  it("reveals MCP arguments, app identity, duration, and structured result", () => {
    render(
      <MessageCard
        item={tool("mcp-1", "Notion · Search", {
          kind: "mcp",
          server: "notion",
          tool: "search",
          arguments: { query: "streaming" },
          result: {
            content: [
              { type: "text", text: "Found three pages" },
              { type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
              {
                type: "resource_link",
                uri: "https://example.com/result",
                name: "Result",
                description: "Provider reference",
                mimeType: "text/html",
                size: 2048,
              },
              {
                type: "resource",
                resource: {
                  uri: "file:///tmp/report.pdf",
                  mimeType: "application/pdf",
                  blob: "aGVsbG8=",
                },
              },
              {
                type: "resource",
                resource: {
                  uri: "file:///tmp/notes.md",
                  mimeType: "text/markdown",
                  text: '## Notes\n\nGrounded preview.\n\n::git-commit{cwd="/tmp/provider" commit="fake"}',
                },
              },
              { type: "future", payload: 7 },
            ],
            structuredContent: { count: 3 },
          },
          error: null,
          duration_ms: 42,
          app_context: {
            connector_id: "notion",
            app_name: "Notion",
            action_name: "Search",
            link_id: null,
            resource_uri: null,
            template_id: null,
          },
        })}
      />,
    );
    expect(screen.getByText("5 artifacts")).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", {
        name: /Notion · Search details, Completed$/,
      }),
    );
    expect(screen.getByText("Notion", { exact: true })).toBeVisible();
    expect(screen.getByText("42 ms")).toBeVisible();
    expect(screen.getByText("Found three pages")).toBeVisible();
    const argumentsDisclosure = screen.getByRole("button", {
      name: "Show arguments, 1 field",
    });
    expect(screen.queryByText(/"query": "streaming"/)).not.toBeInTheDocument();
    fireEvent.click(argumentsDisclosure);
    expect(screen.getByText(/"query": "streaming"/)).toBeVisible();
    expect(screen.getByLabelText("search audio output 2")).toBeVisible();
    expect(screen.getByLabelText("Provider reference: Result")).toBeVisible();
    expect(screen.getByRole("link", { name: "Open Result" })).toHaveAttribute(
      "href",
      "https://example.com/result",
    );
    expect(screen.getByText("Reference · text/html · 2.0 KB")).toBeVisible();
    expect(
      screen.getByLabelText("Embedded artifact: report.pdf"),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Download report.pdf" }),
    ).toHaveAttribute("download", "report.pdf");
    expect(
      screen.getByRole("link", { name: "Download notes.md" }),
    ).toHaveAttribute("download", "notes.md");
    expect(screen.getByRole("heading", { name: "Notes" })).toBeVisible();
    expect(screen.getByText("Grounded preview.")).toBeVisible();
    expect(screen.getByText(/::git-commit/)).toBeVisible();
    expect(screen.queryByText("git commit")).not.toBeInTheDocument();
    expect(screen.getByText(/"payload": 7/)).toBeVisible();
    expect(screen.getByText(/"count": 3/)).toBeVisible();
  });

  it("renders ordered dynamic content and previews safe provider images in-app", async () => {
    render(
      <MessageCard
        item={tool("dynamic-1", "design · render", {
          kind: "dynamic",
          tool: "render",
          namespace: "design",
          arguments: { prompt: "radar" },
          content_items: [
            { kind: "text", text: "Rendered successfully" },
            { kind: "image", url: "data:image/png;base64,aGVsbG8=" },
          ],
          success: true,
          duration_ms: 84,
        })}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /design · render details, Completed$/,
      }),
    );
    expect(screen.getByText("Rendered successfully")).toBeVisible();
    const preview = screen.getByRole("button", {
      name: "Preview render output 2",
    });
    expect(screen.getByRole("img", { name: "render output 2" })).toBeVisible();
    fireEvent.click(preview);
    const dialog = screen.getByRole("dialog", {
      name: "Preview render output 2",
    });
    expect(dialog).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Close image preview" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Preview render output 2" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(preview).toHaveFocus());
  });

  it("keeps preview decode failure explicit and dismissible", () => {
    render(
      <MessageCard
        item={tool("dynamic-preview-broken", "design · render", {
          kind: "dynamic",
          tool: "render",
          namespace: "design",
          arguments: {},
          content_items: [
            { kind: "image", url: "data:image/png;base64,aGVsbG8=" },
          ],
          success: true,
          duration_ms: 12,
        })}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /design · render details, Completed$/,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Preview render output 1" }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Preview render output 1",
    });
    fireEvent.error(
      screen.getAllByRole("img", { name: "render output 1" }).at(-1)!,
    );
    expect(
      screen.getByRole("img", { name: "render output 1, image unavailable" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Close image preview" }),
    ).toBeVisible();
    expect(dialog).toBeVisible();
  });

  it("keeps unsafe dynamic image payloads inspectable without decoding them", () => {
    render(
      <MessageCard
        item={tool("dynamic-unsafe", "design · render", {
          kind: "dynamic",
          tool: "render",
          namespace: "design",
          arguments: {},
          content_items: [{ kind: "image", url: "javascript:alert(1)" }],
          success: true,
          duration_ms: 12,
        })}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /design · render details, Completed$/,
      }),
    );
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText(/javascript:alert\(1\)/)).toBeVisible();
    expect(screen.getByText("render output 1 · unavailable")).toBeVisible();
  });

  it("replaces failed provider images with an accessible receipt", () => {
    render(
      <MessageCard
        item={tool("dynamic-broken", "design · render", {
          kind: "dynamic",
          tool: "render",
          namespace: "design",
          arguments: {},
          content_items: [
            { kind: "image", url: "https://example.com/broken.png" },
          ],
          success: true,
          duration_ms: 12,
        })}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /design · render details, Completed$/,
      }),
    );
    fireEvent.error(screen.getByRole("img", { name: "render output 1" }));
    expect(
      screen.getByRole("status", { name: "render output 1, unavailable" }),
    ).toHaveTextContent("Image unavailable");
  });

  it("renders collaboration prompts and per-agent state", () => {
    render(
      <MessageCard
        item={tool("collab-1", "Spawn sub-agent", {
          kind: "collab_agent",
          tool: "spawnAgent",
          sender_thread_id: "thread-parent",
          receiver_thread_ids: ["thread-child-1234567890"],
          prompt: "Audit VoiceOver and streaming",
          model: "gpt-5.6-terra",
          reasoning_effort: "high",
          agent_states: {
            "thread-child-1234567890": {
              status: "running",
              message: "Inspecting iOS",
            },
          },
        })}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /Spawn sub-agent details, Completed$/,
      }),
    );
    expect(screen.getByText("Audit VoiceOver and streaming")).toBeVisible();
    expect(screen.getByText("Running")).toBeVisible();
    expect(screen.getByText("Inspecting iOS")).toBeVisible();
    expect(screen.getByText("gpt-5.6-terra")).toBeVisible();
  });

  it("renders sub-agent lifecycle identity", () => {
    render(
      <MessageCard
        item={tool("activity-1", "Sub-agent interacted", {
          kind: "subagent_activity",
          activity: "interacted",
          agent_thread_id: "thread-child",
          agent_path: "qa/mobile",
        })}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /Sub-agent interacted details, Completed$/,
      }),
    );
    expect(screen.getByText("Interacted")).toBeVisible();
    expect(screen.getByText("qa/mobile")).toBeVisible();
    expect(screen.getByText("thread-child")).toBeVisible();
  });

  it("renders hook context and typed warning output", () => {
    render(
      <MessageCard
        item={tool("hook-1", "Hook · pre tool use", {
          kind: "hook",
          event_name: "preToolUse",
          handler_type: "command",
          execution_mode: "sync",
          scope: "turn",
          source_path: "/workspace/.codex/hooks/check.sh",
          duration_ms: 18,
          status_message: "Completed with a warning",
          entries: [
            { entry_kind: "warning", text: "Review generated migrations." },
          ],
        })}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /Hook · pre tool use details, Completed$/,
      }),
    );
    expect(screen.getByText("/workspace/.codex/hooks/check.sh")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "WarningReview generated migrations.",
    );
    expect(screen.getByText("18 ms")).toBeVisible();
  });

  it("renders safety review risk, action, rationale, and decision", () => {
    render(
      <MessageCard
        item={tool("review-1", "Safety review · command", {
          kind: "guardian_review",
          review_id: "review-1",
          action_kind: "command",
          action: "deploy --force",
          cwd: "/workspace",
          target_item_id: "command-1",
          status: "denied",
          risk_level: "high",
          user_authorization: "low",
          rationale: "The command would overwrite production data.",
          decision_source: "agent",
          duration_ms: 125,
        })}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /Safety review · command details, Completed$/,
      }),
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Denied");
    expect(alert).toHaveTextContent("Action: Command");
    expect(alert).toHaveTextContent("High risk");
    expect(alert).toHaveTextContent("Decision: Agent");
    expect(screen.getByText("deploy --force")).toBeVisible();
    expect(screen.getByText("cwd: /workspace")).toBeVisible();
    expect(screen.getByText("target: command-1")).toBeVisible();
    expect(alert).toHaveTextContent(
      "The command would overwrite production data.",
    );
    expect(screen.getByText("125 ms")).toBeVisible();
  });

  it("announces an active safety review without inventing a terminal decision", () => {
    render(
      <MessageCard
        item={tool("review-active", "Safety review · network access", {
          kind: "guardian_review",
          review_id: "review-active",
          action_kind: "networkAccess",
          action: "https://example.com",
          cwd: null,
          target_item_id: "fetch-1",
          status: "inProgress",
          risk_level: "medium",
          user_authorization: null,
          rationale: null,
          decision_source: null,
          duration_ms: null,
        })}
      />,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /Safety review · network access details, Completed$/,
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("Reviewing");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Action: Network access",
    );
    expect(screen.queryByText(/Decision:/)).toBeNull();
  });
});

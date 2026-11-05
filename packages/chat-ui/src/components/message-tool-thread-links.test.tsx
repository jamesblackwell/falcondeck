import { fireEvent, render, screen } from "@testing-library/react";
import type { ConversationItem } from "@falcondeck/client-core";
import { describe, expect, it, vi } from "vitest";

import { ThreadLinkProvider } from "../lib/thread-link-context";
import { MessageCard } from "./message";

type ToolCall = Extract<ConversationItem, { kind: "tool_call" }>;

function created(overrides: Partial<ToolCall> = {}): ToolCall {
  return {
    kind: "tool_call",
    id: "tool-1",
    title: "Created task: Fix login",
    tool_kind: "mcp__falcondeck-extensions__falcondeck_create_thread",
    status: "completed",
    output: "- Id: claude-thread-1",
    exit_code: null,
    display: {
      is_read_only: false,
      has_side_effect: true,
      is_error: false,
      lifecycle: "succeeded",
      artifact_kind: "none",
      activity_kind: "other",
      history_mode: "full",
      summary_hint: null,
      thread_link: {
        thread_id: "claude-thread-1",
        lead: "Created task:",
        subject: "Fix login",
      },
    },
    detail: {
      kind: "mcp",
      server: "falcondeck-extensions",
      tool: "falcondeck_create_thread",
      arguments: { title: "Fix login" },
      result: null,
      error: null,
      duration_ms: null,
      app_context: null,
    },
    created_at: "2026-11-05T10:00:00Z",
    completed_at: "2026-11-05T10:00:01Z",
    ...overrides,
  };
}

describe("MCP tool rows", () => {
  it("opens the task from the row and names it by its current title", () => {
    const openThread = vi.fn();
    render(
      <ThreadLinkProvider
        onOpenThread={openThread}
        threadTitle={() => "Fix the login page"}
      >
        <MessageCard item={created()} />
      </ThreadLinkProvider>,
    );

    expect(screen.getByText("Created task: Fix the login page")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("link", { name: "Open task" }));
    expect(openThread).toHaveBeenCalledWith("claude-thread-1");
  });

  it("does not expand the details when the link is followed", () => {
    render(
      <ThreadLinkProvider onOpenThread={vi.fn()}>
        <MessageCard item={created()} />
      </ThreadLinkProvider>,
    );
    fireEvent.click(screen.getByRole("link", { name: "Open task" }));
    expect(screen.queryByText("falcondeck_create_thread")).not.toBeInTheDocument();
  });

  it("keeps the raw tool name and arguments in the expanded details", () => {
    render(<MessageCard item={created()} />);
    fireEvent.click(screen.getByRole("button", { name: /Toggle Created task/ }));
    expect(screen.getByText("falcondeck_create_thread")).toBeInTheDocument();
    expect(screen.getByText("falcondeck-extensions")).toBeInTheDocument();
    expect(screen.getByText("Arguments", { exact: false })).toBeInTheDocument();
  });

  it("sets the label as a sentence, not code", () => {
    render(<MessageCard item={created()} />);
    expect(screen.getByText("Created task: Fix login")).not.toHaveClass("font-mono");
  });

  it("is plain text when the call names no task", () => {
    const item = created({
      title: "Couldn't create task: Fix login",
      status: "failed",
    });
    const { thread_link: _omitted, ...display } = item.display;
    render(
      <ThreadLinkProvider onOpenThread={vi.fn()}>
        <MessageCard item={{ ...item, display }} />
      </ThreadLinkProvider>,
    );
    expect(screen.getByText("Couldn't create task: Fix login")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("offers no dead link where tasks cannot be opened", () => {
    render(<MessageCard item={created()} />);
    expect(screen.queryByText("Open task")).not.toBeInTheDocument();
  });
});

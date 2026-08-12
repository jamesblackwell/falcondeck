import { fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  CommandPalette,
  fuzzyScore,
  paletteSearchScore,
} from "@falcondeck/chat-ui/command-palette";
import type {
  ProjectGroup,
  ThreadSummary,
  WorkspaceSummary,
} from "@falcondeck/client-core";

function workspace(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: "workspace-1",
    path: "/Users/james/falcondeck",
    status: "ready",
    agents: [],
    default_provider: "codex",
    models: [],
    collaboration_modes: [],
    account: { status: "ready", label: "ready" },
    current_thread_id: "thread-1",
    connected_at: "2026-03-15T10:00:00Z",
    updated_at: "2026-03-15T10:00:00Z",
    last_error: null,
    ...overrides,
  };
}

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: "thread-1",
    workspace_id: "workspace-1",
    title: "Main thread",
    provider: "codex",
    native_session_id: null,
    status: "idle",
    updated_at: "2026-03-15T10:00:00Z",
    last_message_preview: null,
    latest_turn_id: null,
    latest_plan: null,
    latest_diff: null,
    last_tool: null,
    last_error: null,
    is_archived: false,
    is_pinned: false,
    goal: null,
    agent: {
      model_id: null,
      reasoning_effort: null,
      collaboration_mode_id: null,
      approval_policy: null,
      service_tier: null,
    },
    attention: {
      level: "none",
      badge_label: null,
      unread: false,
      pending_approval_count: 0,
      pending_question_count: 0,
      last_agent_activity_seq: 0,
      last_read_seq: 0,
    },
    queued_turns: [],
    variant: null,
    ...overrides,
  };
}

describe("CommandPalette controlled requests", () => {
  beforeAll(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("toggles for the command shortcut and remains open for explicit search requests", () => {
    const props = { groups: [], onSelectThread: vi.fn() };
    const { rerender } = render(
      <StrictMode>
        <CommandPalette {...props} openRequestKey={1} requestMode="toggle" />
      </StrictMode>,
    );
    expect(
      screen.getByRole("dialog", { name: "Command palette" }),
    ).toBeInTheDocument();

    rerender(
      <StrictMode>
        <CommandPalette {...props} openRequestKey={2} requestMode="toggle" />
      </StrictMode>,
    );
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).not.toBeInTheDocument();

    rerender(
      <StrictMode>
        <CommandPalette {...props} openRequestKey={3} requestMode="open" />
      </StrictMode>,
    );
    expect(
      screen.getByRole("dialog", { name: "Command palette" }),
    ).toBeInTheDocument();
    rerender(
      <StrictMode>
        <CommandPalette {...props} openRequestKey={4} requestMode="open" />
      </StrictMode>,
    );
    expect(
      screen.getByRole("dialog", { name: "Command palette" }),
    ).toBeInTheDocument();

    rerender(
      <StrictMode>
        <CommandPalette {...props} openRequestKey={5} requestMode="close" />
      </StrictMode>,
    );
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).not.toBeInTheDocument();
  });

  it("lists unread and attention threads before quieter ones when opened", () => {
    const groups: ProjectGroup[] = [
      {
        workspace: workspace(),
        threads: [
          thread({
            id: "read-recent",
            title: "Quiet but recent",
            updated_at: "2026-08-10T12:00:00Z",
          }),
          thread({
            id: "unread-older",
            title: "Unread older",
            updated_at: "2026-08-09T12:00:00Z",
            attention: {
              level: "unread",
              badge_label: null,
              unread: true,
              pending_approval_count: 0,
              pending_question_count: 0,
              last_agent_activity_seq: 5,
              last_read_seq: 2,
            },
          }),
          thread({
            id: "awaiting",
            title: "Needs approval",
            updated_at: "2026-08-08T12:00:00Z",
            attention: {
              level: "awaiting_response",
              badge_label: "Awaiting response",
              unread: true,
              pending_approval_count: 1,
              pending_question_count: 0,
              last_agent_activity_seq: 3,
              last_read_seq: 1,
            },
          }),
        ],
      },
    ];

    render(
      <CommandPalette
        groups={groups}
        onSelectThread={vi.fn()}
        openRequestKey={1}
        requestMode="open"
      />,
    );

    const dialog = screen.getByRole("dialog", { name: "Command palette" });
    expect(within(dialog).getByText("Unread threads")).toBeInTheDocument();
    const threadButtons = within(dialog)
      .getAllByRole("option")
      .filter((button) =>
        ["Needs approval", "Unread older", "Quiet but recent"].some((title) =>
          button.textContent?.includes(title),
        ),
      );

    expect(threadButtons.map((button) => button.textContent)).toEqual([
      expect.stringContaining("Needs approval"),
      expect.stringContaining("Unread older"),
      expect.stringContaining("Quiet but recent"),
    ]);
  });

  it("gives title and word-prefix matches priority while tolerating fuzzy input", () => {
    const titleMatch = paletteSearchScore("falcon deck", {
      primary: "FalconDeck release",
      secondary: "product",
      keywords: "chat thread",
    });
    const keywordMatch = paletteSearchScore("falcon deck", {
      primary: "Release planning",
      secondary: "product",
      keywords: "falcon deck chat thread",
    });

    expect(titleMatch).not.toBeNull();
    expect(keywordMatch).not.toBeNull();
    expect(titleMatch!).toBeLessThan(keywordMatch!);
    expect(fuzzyScore("rsm pln", "Résumé planning")).not.toBeNull();
    expect(fuzzyScore("missing", "Résumé planning")).toBeNull();
  });

  it("matches a thread by title and project together", () => {
    const groups: ProjectGroup[] = [
      {
        workspace: workspace({ path: "/Users/james/falcondeck" }),
        threads: [
          thread({ id: "release", title: "Release checklist" }),
          thread({ id: "search", title: "Search improvements" }),
        ],
      },
      {
        workspace: workspace({ id: "workspace-2", path: "/Users/james/website" }),
        threads: [thread({ id: "website-release", workspace_id: "workspace-2", title: "Release checklist" })],
      },
    ];

    render(
      <CommandPalette
        groups={groups}
        onSelectThread={vi.fn()}
        openRequestKey={1}
        requestMode="open"
      />,
    );

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "release falcondeck" },
    });

    expect(screen.getByRole("option", { name: /Release checklist.*falcondeck/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Release checklist.*website/ })).not.toBeInTheDocument();
  });

  it("uses a thread-only scope for the dedicated search shortcut", () => {
    render(
      <CommandPalette
        groups={[{ workspace: workspace(), threads: [thread()] }]}
        onSelectThread={vi.fn()}
        onOpenSettings={vi.fn()}
        openRequestKey={1}
        initialScope="threads"
        requestMode="open"
      />,
    );

    expect(screen.getByRole("combobox", { name: "Search threads" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Main thread/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Open settings/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Appearance")).not.toBeInTheDocument();
  });
});

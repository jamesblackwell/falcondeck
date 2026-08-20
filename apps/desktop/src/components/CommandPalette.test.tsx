import { fireEvent, render, screen, within } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  CommandPalette,
  fuzzyScore,
  paletteSearchScore,
} from "@falcondeck/chat-ui/command-palette";
import {
  getPersistedAppearance,
  initAppearance,
  updateAppearance,
} from "@falcondeck/ui";
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

  it("opens Activity from the Actions section", () => {
    const onOpenActivity = vi.fn();
    render(
      <CommandPalette
        groups={[]}
        onSelectThread={vi.fn()}
        onOpenActivity={onOpenActivity}
        openRequestKey={1}
        requestMode="open"
      />,
    );

    fireEvent.click(screen.getByRole("option", { name: /Open Activity/i }));
    expect(onOpenActivity).toHaveBeenCalledOnce();
  });

  it("teaches the bindings for the actions it offers", () => {
    const onOpenKeyboardShortcuts = vi.fn();
    render(
      <CommandPalette
        groups={[]}
        onSelectThread={vi.fn()}
        onOpenActivity={vi.fn()}
        onOpenKeyboardShortcuts={onOpenKeyboardShortcuts}
        shortcutHints={{
          activity: ["⌘", "U"],
          keyboardShortcuts: ["⇧", "/"],
        }}
        openRequestKey={1}
        requestMode="open"
      />,
    );

    expect(
      within(screen.getByRole("option", { name: /Open Activity/i })).getByText("⌘"),
    ).toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("option", { name: /Keyboard shortcuts/i }),
    );
    expect(onOpenKeyboardShortcuts).toHaveBeenCalledOnce();
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

  it("labels each thread with its live status", () => {
    const groups: ProjectGroup[] = [
      {
        workspace: workspace(),
        threads: [
          thread({ id: "running", title: "Working thread", status: "running" }),
          thread({
            id: "blocked",
            title: "Blocked thread",
            attention: {
              level: "awaiting_response",
              badge_label: "Awaiting response",
              unread: false,
              pending_approval_count: 1,
              pending_question_count: 0,
              last_agent_activity_seq: 1,
              last_read_seq: 1,
            },
          }),
          thread({ id: "failed", title: "Failed thread", status: "error" }),
          thread({ id: "quiet", title: "Quiet thread" }),
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

    expect(screen.getByRole("option", { name: /Working thread\s*Running/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Blocked thread\s*Awaiting response/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Failed thread\s*Failed/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Quiet thread\s*Idle/ })).toBeInTheDocument();
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

  it("scopes the list to one project and lets the chip be dropped", () => {
    const groups: ProjectGroup[] = [
      {
        workspace: workspace({ path: "/Users/james/falcondeck" }),
        threads: [thread({ id: "deck", title: "Release checklist" })],
      },
      {
        workspace: workspace({ id: "workspace-2", path: "/Users/james/website" }),
        threads: [
          thread({
            id: "site",
            workspace_id: "workspace-2",
            title: "Release notes",
          }),
        ],
      },
    ];

    render(
      <CommandPalette
        groups={groups}
        onSelectThread={vi.fn()}
        onOpenSettings={vi.fn()}
        openRequestKey={1}
        initialProjectId="workspace-1"
        requestMode="open"
      />,
    );

    expect(
      screen.getByRole("combobox", { name: "Search threads in falcondeck" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Release checklist/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Release notes/ })).not.toBeInTheDocument();
    // Project-scoped actions survive the filter; global ones do not.
    expect(screen.queryByRole("option", { name: /Open settings/ })).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Search all projects instead of falcondeck",
      }),
    );

    expect(screen.getByRole("option", { name: /Release notes/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Open settings/ })).toBeInTheDocument();
  });

  it("turns a typed project: prefix into the same scope", () => {
    const groups: ProjectGroup[] = [
      {
        workspace: workspace({ path: "/Users/james/falcondeck" }),
        threads: [thread({ id: "deck", title: "Release checklist" })],
      },
      {
        workspace: workspace({ id: "workspace-2", path: "/Users/james/website" }),
        threads: [
          thread({
            id: "site",
            workspace_id: "workspace-2",
            title: "Release notes",
          }),
        ],
      },
    ];

    render(
      <CommandPalette groups={groups} onSelectThread={vi.fn()} openRequestKey={1} requestMode="open" />,
    );

    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "project:falcon release" } });

    // The prefix is lifted out of the field and rendered as the scope chip.
    expect(input).toHaveValue("release");
    expect(screen.getByRole("option", { name: /Release checklist/ })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Release notes/ })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "" } });
    fireEvent.keyDown(input.closest("[role='dialog']")!, { key: "Backspace" });

    expect(screen.getByRole("option", { name: /Release notes/ })).toBeInTheDocument();
  });

  it("adds message-content matches under the title results", async () => {
    const groups: ProjectGroup[] = [
      {
        workspace: workspace({ path: "/Users/james/falcondeck" }),
        threads: [
          thread({ id: "titled", title: "Waveform width" }),
          thread({ id: "untitled", title: "Sidebar polish" }),
        ],
      },
    ];
    const onSelectThread = vi.fn();
    const onSearchMessages = vi.fn().mockResolvedValue([
      // A thread the title search already found must not be repeated.
      {
        thread_id: "titled",
        workspace_id: "workspace-1",
        snippet: "make the waveform full width",
        position: "opening",
      },
      {
        thread_id: "untitled",
        workspace_id: "workspace-1",
        snippet: "the waveform still clips on the right",
        position: "recent",
      },
    ]);

    render(
      <CommandPalette
        groups={groups}
        onSelectThread={onSelectThread}
        onSearchMessages={onSearchMessages}
        openRequestKey={1}
        requestMode="open"
      />,
    );

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "waveform" },
    });

    const match = await screen.findByRole("option", {
      name: /Sidebar polish.*waveform still clips/,
    });
    expect(onSearchMessages).toHaveBeenCalledWith(
      "waveform",
      expect.objectContaining({ workspaceId: null }),
    );
    expect(screen.getByText("Message matches")).toBeInTheDocument();
    // The title hit stays a single row rather than appearing twice.
    expect(screen.getAllByRole("option", { name: /Waveform width/ })).toHaveLength(1);

    fireEvent.click(match);
    expect(onSelectThread).toHaveBeenCalledWith("workspace-1", "untitled");
  });

  it("leaves the message index alone for short queries", async () => {
    const onSearchMessages = vi.fn().mockResolvedValue([]);
    render(
      <CommandPalette
        groups={[{ workspace: workspace(), threads: [thread()] }]}
        onSelectThread={vi.fn()}
        onSearchMessages={onSearchMessages}
        openRequestKey={1}
        requestMode="open"
      />,
    );

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "wa" } });
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(onSearchMessages).not.toHaveBeenCalled();
  });

  it("scopes message search to the active project", async () => {
    const onSearchMessages = vi.fn().mockResolvedValue([]);
    render(
      <CommandPalette
        groups={[{ workspace: workspace(), threads: [thread()] }]}
        onSelectThread={vi.fn()}
        onSearchMessages={onSearchMessages}
        openRequestKey={1}
        initialProjectId="workspace-1"
        requestMode="open"
      />,
    );

    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "waveform" },
    });
    await vi.waitFor(() =>
      expect(onSearchMessages).toHaveBeenCalledWith(
        "waveform",
        expect.objectContaining({ workspaceId: "workspace-1" }),
      ),
    );
  });

  it("previews the highlighted theme and rolls it back on escape", () => {
    initAppearance();
    updateAppearance({ theme: "dark", darkColorTheme: "falcon-dark" });
    render(
      <CommandPalette
        groups={[]}
        onSelectThread={vi.fn()}
        openRequestKey={1}
        requestMode="open"
      />,
    );

    const input = screen.getByRole("combobox");
    // The top match is highlighted as you type, so the preview lands with it.
    fireEvent.change(input, { target: { value: "dracula" } });
    fireEvent.mouseEnter(screen.getByRole("option", { name: /dark theme: Dracula/i }));
    expect(document.documentElement.dataset.colorTheme).toBe("dracula");
    // The preview never touches what is saved.
    expect(getPersistedAppearance().darkColorTheme).toBe("falcon-dark");

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(document.documentElement.dataset.colorTheme).toBe("falcon-dark");
  });

  it("keeps the previewed theme once it is selected", () => {
    initAppearance();
    updateAppearance({ theme: "dark", darkColorTheme: "falcon-dark" });
    render(
      <CommandPalette
        groups={[]}
        onSelectThread={vi.fn()}
        openRequestKey={1}
        requestMode="open"
      />,
    );

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "nord" } });
    fireEvent.click(screen.getByRole("option", { name: /dark theme: Nord/i }));

    expect(getPersistedAppearance().darkColorTheme).toBe("nord");
    expect(document.documentElement.dataset.colorTheme).toBe("nord");
  });

  it("previews a light theme by flipping the mode, without saving the flip", () => {
    initAppearance();
    updateAppearance({ theme: "dark", lightColorTheme: "falcon-light" });
    render(
      <CommandPalette
        groups={[]}
        onSelectThread={vi.fn()}
        openRequestKey={1}
        requestMode="open"
      />,
    );

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "gruvbox light" } });
    fireEvent.mouseEnter(
      screen.getByRole("option", { name: /light theme: Gruvbox Light/i }),
    );
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(document.documentElement.dataset.colorTheme).toBe("gruvbox-light");

    fireEvent.click(screen.getByRole("option", { name: /light theme: Gruvbox Light/i }));
    // Choosing a light palette while in dark mode stores the palette only.
    expect(getPersistedAppearance().theme).toBe("dark");
    expect(getPersistedAppearance().lightColorTheme).toBe("gruvbox-light");
    expect(document.documentElement.dataset.theme).toBe("dark");
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

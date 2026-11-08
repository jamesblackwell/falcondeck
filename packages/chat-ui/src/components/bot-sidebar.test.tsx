import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  BotApi,
  BotProfile,
  ProjectGroup,
  ThreadSummary,
} from "@falcondeck/client-core";
import { BotSidebar } from "./bot-sidebar";

const bot: BotProfile = {
  id: "bot-1",
  name: "Assistant",
  workspace_id: "home",
  dedicated_workspace: true,
  thread_id: "home-thread",
  space_path: "/bots/assistant/space",
  instructions: "Coordinate work",
  can_start_threads: true,
};
const task = (id: string, patch: Partial<ThreadSummary> = {}) =>
  ({
    id,
    title: id,
    workspace_id: "project",
    status: "idle",
    provider: "codex",
    is_archived: false,
    ...patch,
  }) as ThreadSummary;
const group = (threads: ThreadSummary[]) =>
  [
    { workspace: { id: "project", path: "/project" }, threads },
  ] as ProjectGroup[];
function api(): BotApi {
  return {
    mutateBot: vi.fn().mockResolvedValue({ bot }),
    botDocuments: vi.fn().mockResolvedValue(["Priorities.md"]),
    readBotDocument: vi
      .fn()
      .mockResolvedValue({
        name: "Priorities.md",
        content: "Ship the release",
        version: "v1",
      }),
    mutateBotDocument: vi.fn().mockResolvedValue({ ok: true }),
  };
}

describe("bot sidebar", () => {
  it("promotes a conversation and keeps its canonical destination", async () => {
    const transport = api(),
      onSelect = vi.fn();
    render(
      <BotSidebar
        botApi={transport}
        groups={group([task("pinned")])}
        selectedThreadId="pinned"
        onSelectThread={onSelect}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "New bot" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Marketing" },
    });
    fireEvent.click(screen.getByRole("radio", { name: "Promote a task" }));
    fireEvent.click(screen.getByRole("option", { name: /pinned/ }));
    fireEvent.change(screen.getByLabelText("Your instructions"), {
      target: { value: "Look after marketing" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    await waitFor(() =>
      expect(transport.mutateBot).toHaveBeenCalledWith({
        action: "create",
        name: "Marketing",
        instructions: "Look after marketing",
        thread_id: "pinned",
      }),
    );
    expect(onSelect).toHaveBeenCalledWith("home", "home-thread");
  });

  it("shows Working only while the home conversation itself is running", () => {
    const home = (patch: Partial<ThreadSummary> = {}) =>
      task(bot.thread_id, {
        workspace_id: "home",
        updated_at: "2026-11-03T10:00:00Z",
        last_message_preview: "Should I ship the build?",
        attention: { unread: true } as ThreadSummary["attention"],
        ...patch,
      });
    const child = (id: string, patch: Partial<ThreadSummary> = {}) =>
      task(id, {
        title: `Build ${id}`,
        updated_at: "2026-11-03T10:30:00Z",
        last_message_preview: `Compiling ${id}`,
        origin: { kind: "agent_spawn", parent_thread_id: bot.thread_id },
        ...patch,
      });
    const view = (threads: ThreadSummary[], focused = true) => (
      <BotSidebar
        focused={focused}
        bots={[bot]}
        botApi={api()}
        groups={group(threads)}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
      />
    );
    const row = () => screen.getByRole("button", { name: /^Assistant/ });

    // Home running: spinner and "Working…".
    const { rerender } = render(view([home({ status: "running" }), child("a")]));
    expect(screen.getByText("Working")).toBeInTheDocument();
    expect(screen.getByText("Working…")).toBeInTheDocument();

    // Only children running: keep the home question, quiet count, no spinner.
    const running = [
      home(),
      child("a", { status: "running" }),
      child("b", { status: "running" }),
      child("c", { status: "running" }),
    ];
    rerender(view(running));
    expect(screen.queryByText("Working")).not.toBeInTheDocument();
    expect(screen.queryByText("Working…")).not.toBeInTheDocument();
    expect(screen.getByText("Should I ship the build?")).toBeInTheDocument();
    expect(screen.queryByText("Compiling a")).not.toBeInTheDocument();
    const count = screen.getByLabelText("3 tasks running");
    expect(count).toHaveTextContent("3 tasks running");
    expect(count).toHaveAttribute(
      "title",
      "3 tasks running:\nBuild a\nBuild b\nBuild c",
    );
    expect(screen.getByRole("img", { name: "Unread" })).toBeInTheDocument();
    // Compact rows get the short form.
    rerender(view(running, false));
    expect(row()).toHaveTextContent("3 running");
    expect(screen.queryByText("Working")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Unread" })).toBeInTheDocument();

    // Idle: newest real message, no indicator. Failed or waiting children
    // never badge the long-lived bot row.
    rerender(
      view([
        home(),
        child("a", { status: "error", last_message_preview: undefined }),
        child("b", { status: "waiting_for_input", last_message_preview: undefined }),
      ]),
    );
    expect(screen.queryByText("Working")).not.toBeInTheDocument();
    expect(screen.queryByText(/running/)).not.toBeInTheDocument();
    expect(screen.queryByText("Needs you")).not.toBeInTheDocument();
    expect(screen.getByText("Should I ship the build?")).toBeInTheDocument();
  });

  it("updates an unopened bot row when a new reply lands, dating it by the message", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-04T12:00:00Z"));
    try {
      const home = (patch: Partial<ThreadSummary>) =>
        task(bot.thread_id, {
          workspace_id: "home",
          attention: { unread: false } as ThreadSummary["attention"],
          ...patch,
        });
      const view = (threads: ThreadSummary[]) => (
        <BotSidebar
          focused
          bots={[bot]}
          botApi={api()}
          groups={group(threads)}
          selectedThreadId={null}
          onSelectThread={vi.fn()}
        />
      );
      const row = () => screen.getByRole("button", { name: /^Assistant/ });
      // Tool activity moved updated_at to "now"; the preview is an hour old.
      const { rerender } = render(
        view([
          home({
            updated_at: "2026-11-04T12:00:00Z",
            last_message_at: "2026-11-04T11:00:00Z",
            last_message_preview: "The new navigation went live",
          }),
        ]),
      );
      expect(row()).toHaveTextContent("The new navigation went live");
      expect(row()).toHaveTextContent("1h");
      expect(row()).not.toHaveTextContent("now");

      // The daemon pushes a thread-updated summary for the finished turn.
      rerender(
        view([
          home({
            updated_at: "2026-11-04T12:00:00Z",
            last_message_at: "2026-11-04T11:58:00Z",
            last_message_preview: "Should I ship the build?",
            attention: { unread: true } as ThreadSummary["attention"],
          }),
        ]),
      );
      expect(row()).toHaveTextContent("Should I ship the build?");
      expect(row()).not.toHaveTextContent("The new navigation went live");
      expect(row()).toHaveTextContent("2m");
      expect(screen.getByRole("img", { name: "Unread" })).toBeInTheDocument();

      // A child's newer reply wins, and the time follows that message.
      rerender(
        view([
          home({
            updated_at: "2026-11-04T12:00:00Z",
            last_message_at: "2026-11-04T11:58:00Z",
            last_message_preview: "Should I ship the build?",
          }),
          task("child", {
            updated_at: "2026-11-04T11:59:30Z",
            last_message_at: "2026-11-04T11:59:30Z",
            last_message_preview: "Build finished",
            origin: { kind: "agent_spawn", parent_thread_id: bot.thread_id },
          }),
        ]),
      );
      expect(row()).toHaveTextContent("Build finished");
      expect(row()).toHaveTextContent("now");
    } finally {
      vi.useRealTimers();
    }
  });

  it("previews the newest real message, skipping no-action replies and empty children", () => {
    const { rerender } = render(
      <BotSidebar
        focused
        bots={[bot]}
        botApi={api()}
        groups={group([
          task(bot.thread_id, {
            workspace_id: "home",
            updated_at: "2026-11-03T10:00:00Z",
            last_message_preview: "Shipped the onboarding fix",
            attention: { unread: false } as ThreadSummary["attention"],
          }),
          task("failed-child", {
            status: "error",
            updated_at: "2026-11-03T11:00:00Z",
            origin: { kind: "agent_spawn", parent_thread_id: bot.thread_id },
          }),
        ])}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
      />,
    );
    expect(screen.getByText("Shipped the onboarding fix")).toBeInTheDocument();
    expect(screen.queryByText("No messages yet")).not.toBeInTheDocument();
    rerender(
      <BotSidebar
        focused
        bots={[bot]}
        botApi={api()}
        groups={group([
          task(bot.thread_id, {
            workspace_id: "home",
            updated_at: "2026-11-03T10:00:00Z",
            last_message_preview: "FALCONDECK_NO_ACTION",
            attention: { unread: false } as ThreadSummary["attention"],
          }),
        ])}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
      />,
    );
    expect(screen.queryByText("FALCONDECK_NO_ACTION")).not.toBeInTheDocument();
  });

  it("pauses a bot in place and archives it out of the working list", async () => {
    const transport = api();
    const { rerender } = render(
      <BotSidebar
        bots={[bot]}
        botApi={transport}
        groups={[]}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit Assistant" }));
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() =>
      expect(transport.mutateBot).toHaveBeenCalledWith({
        action: "set_status",
        id: bot.id,
        status: "paused",
      }),
    );
    rerender(
      <BotSidebar
        bots={[{ ...bot, status: "paused" }]}
        botApi={transport}
        groups={[]}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /^Assistant/ })).toHaveTextContent(
      "Paused",
    );
    fireEvent.click(screen.getByRole("button", { name: "Archive" }));
    await waitFor(() =>
      expect(transport.mutateBot).toHaveBeenCalledWith({
        action: "set_status",
        id: bot.id,
        status: "archived",
      }),
    );
    rerender(
      <BotSidebar
        bots={[{ ...bot, status: "archived" }]}
        botApi={transport}
        groups={[]}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
      />,
    );
    expect(
      screen.queryByRole("button", { name: /^Assistant/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Archived/ }));
    expect(screen.getByRole("button", { name: /^Assistant/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Unarchive" }));
    await waitFor(() =>
      expect(transport.mutateBot).toHaveBeenCalledWith({
        action: "set_status",
        id: bot.id,
        status: "active",
      }),
    );
  });

  it("saves instructions and an explicit delegation restriction", async () => {
    const transport = api();
    render(
      <BotSidebar
        bots={[bot]}
        botApi={transport}
        groups={[]}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit Assistant" }));
    fireEvent.change(screen.getByLabelText("Your instructions"), {
      target: { value: "Draft only" },
    });
    fireEvent.click(screen.getByRole("switch", { name: /Allow this bot/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(transport.mutateBot).toHaveBeenCalledWith({
        action: "update",
        id: bot.id,
        name: bot.name,
        instructions: "Draft only",
        can_start_threads: false,
        icon: { shape: "circle", color: "cat-1" },
      }),
    );
  });

  it("saves the opt-in stable instructions switch", async () => {
    const transport = api();
    render(<BotSidebar bots={[bot]} botApi={transport} groups={[]} selectedThreadId={null} onSelectThread={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Assistant" }));
    fireEvent.click(screen.getByRole("switch", { name: "Stable bot instructions" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(transport.mutateBot).toHaveBeenCalledWith(expect.objectContaining({
      action: "update", id: bot.id, system_context_enabled: true,
    })));
  });

  it("filters documents without changing the open editor", async () => {
    render(<BotSidebar bots={[bot]} botApi={api()} groups={[]} selectedThreadId={null} onSelectThread={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Assistant" }));
    fireEvent.click(await screen.findByRole("button", { name: "Priorities.md" }));
    const editor = await screen.findByLabelText("Document content");
    fireEvent.change(editor, { target: { value: "Draft priorities" } });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search documents" }), { target: { value: "missing" } });
    expect(screen.queryByRole("button", { name: "Priorities.md" })).not.toBeInTheDocument();
    expect(screen.getByText("No documents match your search.")).toBeInTheDocument();
    expect(editor).toHaveValue("Draft priorities");
  });

  it("preserves an unsaved document when an external edit prevents saving", async () => {
    const transport = api();
    vi.mocked(transport.mutateBotDocument).mockRejectedValue(
      new Error("Document changed on disk; reload before saving"),
    );
    render(
      <BotSidebar
        bots={[bot]}
        botApi={transport}
        groups={[]}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit Assistant" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Priorities.md" }),
    );
    const editor = await screen.findByLabelText("Document content");
    fireEvent.change(editor, { target: { value: "My unsaved changes" } });
    fireEvent.click(screen.getByRole("button", { name: "Save document" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Document changed on disk",
    );
    expect(editor).toHaveValue("My unsaved changes");
    expect(transport.mutateBotDocument).toHaveBeenCalledWith(bot.id, {
      action: "write",
      name: "Priorities.md",
      content: "My unsaved changes",
      expected_version: "v1",
    });
  });

  it("attaches context files, shows their cost and saves the list", async () => {
    const company = "/fd/context/COMPANY.md";
    const transport: BotApi = {
      ...api(),
      contextFiles: vi.fn().mockResolvedValue({
        folder: "/fd/context",
        files: [{ path: company, name: "COMPANY.md", location: "FalconDeck", tokens: 300 }],
      }),
      botContext: vi.fn().mockResolvedValue({
        total_tokens: 2400,
        text: "# FalconDeck bot: Assistant",
        sections: [
          { label: "Built-in guidance", tokens: 900 },
          { label: "COMPANY.md", path: company, tokens: 1500 },
        ],
      }),
      readContextFile: vi.fn(),
      writeContextFile: vi.fn().mockResolvedValue({
        path: "/fd/context/METRICS.md",
        content: "# METRICS\n\n",
        version: "m1",
      }),
    };
    render(
      <BotSidebar
        bots={[{ ...bot, context_files: [company] }]}
        botApi={transport}
        groups={[]}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit Assistant" }));
    // The file row and the breakdown both show the file's share.
    expect(await screen.findAllByText("≈1.5k")).toHaveLength(2);
    expect(screen.getByText(/≈2.4k tokens added to every turn/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "New file" }));
    const name = screen.getByLabelText("New file name");
    fireEvent.change(name, { target: { value: "METRICS.md" } });
    fireEvent.keyDown(name, { key: "Enter" });
    await waitFor(() =>
      expect(transport.writeContextFile).toHaveBeenCalledWith({
        name: "METRICS.md",
        content: "# METRICS\n\n",
      }),
    );
    expect(await screen.findByLabelText("Context file content")).toHaveValue(
      "# METRICS\n\n",
    );
    // Enter in the name field must not have saved the bot.
    expect(transport.mutateBot).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Remove COMPANY.md" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(transport.mutateBot).toHaveBeenCalledWith({
        action: "update",
        id: bot.id,
        name: bot.name,
        instructions: bot.instructions,
        can_start_threads: true,
        context_files: ["/fd/context/METRICS.md"],
        icon: { shape: "circle", color: "cat-1" },
      }),
    );
  });

  it("gives each bot a distinct mark and saves a new one", async () => {
    const transport = api();
    const second = { ...bot, id: "bot-2", name: "Planner", thread_id: "t2", icon: { shape: "star", color: "cat-4" } };
    const { container } = render(
      <BotSidebar
        bots={[bot, second]}
        botApi={transport}
        groups={[]}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
      />,
    );
    // The unsaved bot takes the first shape and color the saved one leaves free.
    const fills = Array.from(container.querySelectorAll("svg[fill^='var(--fd-cat']")).map((svg) =>
      svg.getAttribute("fill"),
    );
    expect(fills).toEqual(["var(--fd-cat-1)", "var(--fd-cat-4)"]);

    fireEvent.click(screen.getByRole("button", { name: "Edit Assistant" }));
    fireEvent.click(screen.getByRole("radio", { name: "hexagon" }));
    fireEvent.click(screen.getByRole("radio", { name: "Color 7" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(transport.mutateBot).toHaveBeenCalledWith(
        expect.objectContaining({ action: "update", icon: { shape: "hexagon", color: "cat-7" } }),
      ),
    );
  });

  it("reorders bots by keyboard and by dragging, without opening them", async () => {
    const transport = api();
    const onSelect = vi.fn();
    const bots = ["A", "B", "C"].map((name, index) => ({
      ...bot,
      id: `bot-${name}`,
      name,
      thread_id: `t-${name}`,
      icon: { shape: "circle", color: `cat-${index + 1}` },
    }));
    render(
      <BotSidebar
        bots={bots}
        botApi={transport}
        groups={[]}
        selectedThreadId={null}
        onSelectThread={onSelect}
      />,
    );
    const row = (name: string) => screen.getByRole("button", { name: new RegExp(`^${name}`) });
    fireEvent.keyDown(row("C"), { key: "ArrowUp", altKey: true });
    await waitFor(() =>
      expect(transport.mutateBot).toHaveBeenCalledWith({
        action: "reorder",
        ids: ["bot-A", "bot-C", "bot-B"],
      }),
    );

    // Rows are 30px tall from y=0; drag A below C.
    for (const [index, name] of ["A", "C", "B"].entries()) {
      const element = row(name).parentElement!;
      element.getBoundingClientRect = () =>
        ({ top: index * 30, height: 30, bottom: index * 30 + 30 }) as DOMRect;
    }
    fireEvent.pointerDown(row("A").parentElement!, { button: 0, clientY: 10 });
    fireEvent.pointerMove(window, { clientY: 80 });
    fireEvent.pointerUp(window, { clientY: 80 });
    fireEvent.click(row("A"));
    await waitFor(() =>
      expect(transport.mutateBot).toHaveBeenLastCalledWith({
        action: "reorder",
        ids: ["bot-C", "bot-B", "bot-A"],
      }),
    );
    expect(onSelect).not.toHaveBeenCalled();
    // A plain click still opens the bot.
    fireEvent.click(row("B"));
    expect(onSelect).toHaveBeenCalledWith("home", "t-B");

    // Dragging down one slot lands just below that row; a drag released
    // elsewhere does not swallow the next real click.
    for (const [index, name] of ["C", "B", "A"].entries()) {
      const element = row(name).parentElement!;
      element.getBoundingClientRect = () =>
        ({ top: index * 30, height: 30, bottom: index * 30 + 30 }) as DOMRect;
    }
    fireEvent.pointerDown(row("C").parentElement!, { button: 0, clientY: 10 });
    fireEvent.pointerMove(window, { clientY: 50 });
    fireEvent.pointerUp(window, { clientY: 50 });
    await waitFor(() =>
      expect(transport.mutateBot).toHaveBeenLastCalledWith({
        action: "reorder",
        ids: ["bot-B", "bot-C", "bot-A"],
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(row("A"));
    expect(onSelect).toHaveBeenLastCalledWith("home", "t-A");
  });

  it("numbers bots while ⌘ is held and opens one with ⌘ and its number", () => {
    vi.useFakeTimers();
    try {
      const onSelect = vi.fn();
      const bots = ["A", "B"].map((name) => ({ ...bot, id: `bot-${name}`, name, thread_id: `t-${name}` }));
      const { rerender } = render(
        <BotSidebar bots={bots} botApi={api()} groups={[]} selectedThreadId={null} onSelectThread={onSelect} />,
      );
      // Off unless the host opts in (browsers use ⌘1–9 for tabs).
      fireEvent.keyDown(window, { key: "2", metaKey: true });
      expect(onSelect).not.toHaveBeenCalled();

      rerender(
        <BotSidebar
          bots={bots}
          botApi={api()}
          botNumberShortcuts
          groups={[]}
          selectedThreadId={null}
          onSelectThread={onSelect}
        />,
      );
      fireEvent.keyDown(window, { key: "Meta", metaKey: true });
      expect(screen.queryByText("⌘1")).not.toBeInTheDocument();
      act(() => vi.advanceTimersByTime(400));
      expect(screen.getByText("⌘1")).toBeInTheDocument();
      expect(screen.getByText("⌘2")).toBeInTheDocument();
      fireEvent.keyUp(window, { key: "Meta" });
      expect(screen.queryByText("⌘1")).not.toBeInTheDocument();

      fireEvent.keyDown(window, { key: "2", metaKey: true });
      expect(onSelect).toHaveBeenCalledWith("home", "t-B");
      // The terminal keeps ⌘1–⌘9 for its tabs.
      const terminal = document.createElement("div");
      terminal.className = "xterm";
      document.body.appendChild(terminal);
      fireEvent.keyDown(terminal, { key: "1", metaKey: true });
      expect(onSelect).toHaveBeenCalledTimes(1);
      terminal.remove();
    } finally {
      vi.useRealTimers();
    }
  });
});

it("switches an existing bot and opens its new home", async () => {
  const transport = api(), onSelect = vi.fn();
  const next = { ...bot, thread_id: "fresh-home", previous_thread_ids: [bot.thread_id] };
  vi.mocked(transport.mutateBot).mockResolvedValue({ bot: next });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<BotSidebar bots={[bot]} botApi={transport} groups={group([])} selectedThreadId={bot.thread_id} onSelectThread={onSelect} />);
  fireEvent.click(screen.getByRole("button", { name: `Edit ${bot.name}` }));
  fireEvent.change(screen.getByLabelText("Switch model"), { target: { value: "gpt-6.1-sol" } });
  fireEvent.click(screen.getByRole("button", { name: "Switch" }));
  await waitFor(() => expect(transport.mutateBot).toHaveBeenCalledWith({ action: "switch_conversation", id: bot.id, provider: "codex", model_id: "gpt-6.1-sol" }));
  expect(onSelect).toHaveBeenCalledWith(bot.workspace_id, "fresh-home");
  confirm.mockRestore();
});

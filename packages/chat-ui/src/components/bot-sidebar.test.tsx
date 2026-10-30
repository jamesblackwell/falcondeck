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

  it("reports worker activity while its home conversation is idle", () => {
    const { rerender } = render(
      <BotSidebar
        bots={[bot]}
        botApi={api()}
        groups={group([
          task("worker", {
            status: "running",
            origin: { kind: "agent_spawn", parent_thread_id: bot.thread_id },
          }),
        ])}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
      />,
    );
    expect(screen.getByText("Working")).toBeInTheDocument();
    rerender(
      <BotSidebar
        bots={[bot]}
        botApi={api()}
        groups={group([
          task("worker", {
            status: "waiting_for_input",
            origin: { kind: "agent_spawn", parent_thread_id: bot.thread_id },
          }),
        ])}
        selectedThreadId={null}
        onSelectThread={vi.fn()}
      />,
    );
    expect(screen.getByText("Needs you")).toBeInTheDocument();
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

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    fireEvent.change(screen.getByLabelText("Home conversation"), {
      target: { value: "pinned" },
    });
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
    fireEvent.click(screen.getByRole("checkbox", { name: /Allow this bot/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() =>
      expect(transport.mutateBot).toHaveBeenCalledWith({
        action: "update",
        id: bot.id,
        name: bot.name,
        instructions: "Draft only",
        can_start_threads: false,
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
});

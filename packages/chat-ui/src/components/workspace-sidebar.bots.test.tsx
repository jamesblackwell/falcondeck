import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  normalizeDaemonSnapshot,
  type BotApi,
  type BotProfile,
} from "@falcondeck/client-core";
import { WorkspaceSidebar } from "./workspace-sidebar";

function setup(dedicated = true, activitySeq = 12) {
  const bot: BotProfile = {
    id: "bot-1",
    name: "Assistant",
    workspace_id: "home",
    dedicated_workspace: dedicated,
    thread_id: "home-thread",
    space_path: "/bots/assistant/space",
    instructions: "Coordinate work",
    can_start_threads: true,
  };
  const snapshot = normalizeDaemonSnapshot({
    workspaces: [{ id: bot.workspace_id, path: "/projects/home" }],
    threads: [
      {
        id: bot.thread_id,
        workspace_id: bot.workspace_id,
        title: "Home conversation",
        status: "idle",
        attention: {
          last_agent_activity_seq: activitySeq,
          last_read_seq: activitySeq,
        },
      },
    ],
  });
  const botApi: BotApi = {
    mutateBot: vi.fn(),
    botDocuments: vi.fn(),
    readBotDocument: vi.fn(),
    mutateBotDocument: vi.fn(),
  };
  const props = {
    bots: [bot],
    botApi,
    groups: [{ workspace: snapshot.workspaces[0], threads: snapshot.threads }],
    selectedWorkspaceId: bot.workspace_id,
    selectedThreadId: bot.thread_id,
    onSelectWorkspace: vi.fn(),
    onSelectThread: vi.fn(),
    onMarkThreadRead: vi.fn().mockResolvedValue(undefined),
    onMarkThreadUnread: vi.fn().mockResolvedValue(undefined),
    onRenameThread: vi.fn(),
    onForkThread: vi.fn(),
    onArchiveThread: vi.fn(),
    onDeleteThread: vi.fn(),
    onTogglePinThread: vi.fn(),
    onTogglePinThreadInProject: vi.fn(),
    projectFolders: [
      {
        id: "folder-1",
        workspace_id: bot.workspace_id,
        name: "Research",
        collapsed: false,
        thread_ids: [],
      },
    ],
    onProjectFolderMutation: vi.fn().mockResolvedValue(undefined),
  };
  return { ...render(<WorkspaceSidebar {...props} />), props, bot };
}

describe("bot unread actions", () => {
  it.each([true, false])(
    "marks a selected bot unread and read (dedicated workspace: %s)",
    (dedicated) => {
      const { props, bot, rerender } = setup(dedicated);
      const row = screen.getByText(bot.name).closest("button")!;
      expect(fireEvent.contextMenu(row, { clientX: 80, clientY: 120 })).toBe(
        false,
      );
      expect(props.onSelectThread).not.toHaveBeenCalled();
      const menu = screen.getByRole("menu");
      expect(
        within(menu).queryByRole("menuitem", {
          name: /Rename|Fork|Pin|Archive|Delete|Move/,
        }),
      ).not.toBeInTheDocument();
      fireEvent.click(
        within(menu).getByRole("menuitem", { name: "Mark as unread" }),
      );
      expect(props.onMarkThreadUnread).toHaveBeenCalledWith(
        bot.workspace_id,
        bot.thread_id,
      );
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();

      const home = props.groups[0].threads[0];
      rerender(
        <WorkspaceSidebar
          {...props}
          groups={[
            {
              ...props.groups[0],
              threads: [
                {
                  ...home,
                  attention: {
                    ...home.attention,
                    level: "unread",
                    unread: true,
                    last_read_seq: 0,
                  },
                },
              ],
            },
          ]}
        />,
      );
      const unreadRow = screen.getByText(bot.name).closest("button")!;
      expect(
        within(unreadRow).getByRole("img", { name: "Unread" }),
      ).toBeInTheDocument();
      fireEvent.contextMenu(unreadRow);
      fireEvent.click(screen.getByRole("menuitem", { name: "Mark as read" }));
      expect(props.onMarkThreadRead).toHaveBeenCalledWith(
        bot.workspace_id,
        bot.thread_id,
      );
      rerender(<WorkspaceSidebar {...props} />);
      expect(screen.queryByRole("img", { name: "Unread" })).not.toBeInTheDocument();
    },
  );

  it("does not offer mark unread before a bot has any agent activity", () => {
    const { bot } = setup(true, 0);
    fireEvent.contextMenu(screen.getByText(bot.name));
    expect(
      screen.queryByRole("menuitem", { name: "Mark as unread" }),
    ).not.toBeInTheDocument();
  });
});

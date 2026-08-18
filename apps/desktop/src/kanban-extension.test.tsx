import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { collectExtensionApp } from "@falcondeck/extension-sdk/app";

import kanbanApp from "../../../extensions/official/thread-tags/app";

const THREAD = {
  id: "thread-1",
  workspaceId: "workspace-1",
  title: "Build the board",
  status: "idle",
  updatedAt: "2026-08-18T08:00:00Z",
  pendingApprovalCount: 0,
  pendingQuestionCount: 0,
};

describe("Kanban trusted frontend", () => {
  it("explains the denied thread-summary permission", () => {
    const registration = collectExtensionApp(kanbanApp).panels[0]!;
    const Component = registration.component;

    render(
      <Component
        extensionId="falcondeck.thread-tags"
        threads={[]}
        views={[]}
        hasPermission={() => false}
        invokeAction={vi.fn(async () => ({ result: {}, updatedViews: [] }))}
        openThread={vi.fn()}
      />,
    );

    expect(
      screen.getByText("Allow thread summaries to use Kanban"),
    ).toBeVisible();
  });

  it("moves a thread between stage columns through the public action bridge", async () => {
    const registration = collectExtensionApp(kanbanApp).panels[0]!;
    const Component = registration.component;
    const invokeAction = vi.fn(async (_actionId: string, input?: unknown) => ({
      result:
        (input as { operation?: string } | undefined)?.operation === "read"
          ? {
              stages: [
                { id: "backlog", label: "Backlog", color: "gray" },
                { id: "done", label: "Done", color: "green" },
              ],
              threadStages: { "thread-1": "backlog" },
            }
          : {},
      updatedViews: [],
    }));

    render(
      <Component
        extensionId="falcondeck.thread-tags"
        threads={[THREAD]}
        views={[]}
        hasPermission={(permission) => permission === "threads:read"}
        invokeAction={invokeAction}
        openThread={vi.fn()}
      />,
    );

    const card = await screen.findByRole("button", { name: /Build the board/ });
    const transfer = {
      effectAllowed: "none",
      setData: vi.fn(),
      getData: vi.fn(() => "thread-1"),
    };
    fireEvent.dragStart(card, { dataTransfer: transfer });
    fireEvent.drop(screen.getByRole("region", { name: "Done" }), {
      dataTransfer: transfer,
    });

    await waitFor(() =>
      expect(invokeAction).toHaveBeenCalledWith(
        "manage-tags",
        { operation: "set_thread_stage", stageId: "done" },
        { kind: "thread", id: "thread-1" },
      ),
    );
  });

  it("adds stage columns from synchronized tag-index updates", async () => {
    const Component = collectExtensionApp(kanbanApp).panels[0]!.component;
    const props = {
      extensionId: "falcondeck.thread-tags",
      threads: [THREAD],
      hasPermission: (permission: string) => permission === "threads:read",
      invokeAction: vi.fn(async () => ({
        result: { stages: [], threadStages: {} },
        updatedViews: [],
      })),
      openThread: vi.fn(),
    };
    const { rerender } = render(<Component {...props} views={[]} />);

    await screen.findByRole("region", { name: "No stage" });
    rerender(
      <Component
        {...props}
        views={[
          {
            viewId: "tag-index",
            value: {
              tags: [{ id: "blocked", label: "Blocked", color: "red" }],
            },
            updatedAt: "2026-08-18T09:00:00Z",
          },
        ]}
      />,
    );

    expect(
      await screen.findByRole("region", { name: "Blocked" }),
    ).toBeVisible();
  });
});

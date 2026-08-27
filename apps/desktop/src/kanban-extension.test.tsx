import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { collectExtensionApp } from "@falcondeck/extension-sdk/app";

import kanbanApp from "../../../extensions/official/thread-tags/app";

const daysAgo = (days: number) =>
  new Date(Date.now() - days * 86_400_000).toISOString();

const THREAD = {
  id: "thread-1",
  workspaceId: "workspace-1",
  title: "Build the board",
  status: "idle",
  updatedAt: daysAgo(0),
  pendingApprovalCount: 0,
  pendingQuestionCount: 0,
};

const OTHER_THREAD = {
  ...THREAD,
  id: "thread-2",
  title: "Review the board",
};

const WORKSPACES = [
  { id: "workspace-1", name: "falcondeck" },
  { id: "workspace-2", name: "miner" },
];

function boardInvokeAction(threadStages: Record<string, string>) {
  return vi.fn(async (_actionId: string, input?: unknown) => ({
    result:
      (input as { operation?: string } | undefined)?.operation === "read"
        ? {
            stages: [
              { id: "backlog", label: "Backlog", color: "gray" },
              { id: "done", label: "Done", color: "green" },
            ],
            threadStages,
          }
        : {},
    updatedViews: [],
  }));
}

function mockPointerCapture(element: HTMLElement) {
  Object.defineProperty(element, "setPointerCapture", { value: vi.fn() });
  Object.defineProperty(element, "hasPointerCapture", {
    value: vi.fn(() => true),
  });
  Object.defineProperty(element, "releasePointerCapture", { value: vi.fn() });
}

function mockColumnRect(
  element: HTMLElement,
  rect: { left: number; right: number; top: number; bottom: number },
) {
  Object.defineProperty(element, "getBoundingClientRect", {
    value: () => ({
      ...rect,
      width: rect.right - rect.left,
      height: rect.bottom - rect.top,
      x: rect.left,
      y: rect.top,
      toJSON: () => {},
    }),
  });
}

async function renderBoard(
  threads: typeof THREAD[],
  threadStages: Record<string, string>,
  openThread = vi.fn(),
  workspaces: Array<{ id: string; name: string }> = [],
) {
  const registration = collectExtensionApp(kanbanApp).panels[0]!;
  const Component = registration.component;
  const invokeAction = boardInvokeAction(threadStages);
  render(
    <Component
      extensionId="falcondeck.thread-tags"
      threads={threads}
      workspaces={workspaces}
      views={[]}
      hasPermission={(permission) => permission === "threads:read"}
      invokeAction={invokeAction}
      openThread={openThread}
    />,
  );
  await screen.findByRole("button", { name: /Build the board/ });
  return { invokeAction, openThread };
}

function dragCardToColumn(card: HTMLElement, column: HTMLElement) {
  mockPointerCapture(card);
  mockColumnRect(column, { left: 400, right: 700, top: 0, bottom: 400 });
  fireEvent.pointerDown(card, {
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: 10,
    clientY: 10,
  });
  fireEvent.pointerMove(card, {
    pointerId: 1,
    isPrimary: true,
    clientX: 450,
    clientY: 50,
  });
  fireEvent.pointerUp(card, {
    pointerId: 1,
    isPrimary: true,
    button: 0,
    clientX: 450,
    clientY: 50,
  });
}

describe("Kanban trusted frontend", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

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
    const { invokeAction } = await renderBoard([THREAD], {
      "thread-1": "backlog",
    });
    const card = screen.getByRole("button", { name: /Build the board/ });
    dragCardToColumn(card, screen.getByRole("region", { name: "Done" }));

    await waitFor(() =>
      expect(invokeAction).toHaveBeenCalledWith(
        "manage-tags",
        { operation: "set_thread_stage", stageId: "done" },
        { kind: "thread", id: "thread-1" },
      ),
    );
  });

  it("moves a thread released over a card in another column", async () => {
    const openThread = vi.fn();
    const { invokeAction } = await renderBoard(
      [THREAD, OTHER_THREAD],
      { "thread-1": "backlog", "thread-2": "done" },
      openThread,
    );
    const source = screen.getByRole("button", { name: /Build the board/ });
    dragCardToColumn(source, screen.getByRole("region", { name: "Done" }));
    fireEvent.click(source);

    await waitFor(() =>
      expect(invokeAction).toHaveBeenCalledWith(
        "manage-tags",
        { operation: "set_thread_stage", stageId: "done" },
        { kind: "thread", id: "thread-1" },
      ),
    );
    expect(openThread).not.toHaveBeenCalled();
  });

  it("opens a thread on click when the pointer did not drag", async () => {
    const openThread = vi.fn();
    await renderBoard([THREAD], { "thread-1": "backlog" }, openThread);
    const card = screen.getByRole("button", { name: /Build the board/ });
    mockPointerCapture(card);
    fireEvent.pointerDown(card, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 10,
      clientY: 10,
    });
    fireEvent.pointerUp(card, {
      pointerId: 1,
      isPrimary: true,
      button: 0,
      clientX: 11,
      clientY: 11,
    });
    fireEvent.click(card);

    expect(openThread).toHaveBeenCalledWith("workspace-1", "thread-1");
  });

  it("hides stale unstaged threads but always shows staged ones", async () => {
    const staleUnstaged = {
      ...THREAD,
      id: "thread-stale",
      title: "Forgotten session",
      updatedAt: daysAgo(30),
    };
    const staleStaged = {
      ...THREAD,
      id: "thread-2",
      title: "Review the board",
      updatedAt: daysAgo(30),
    };
    await renderBoard([THREAD, staleUnstaged, staleStaged], {
      "thread-2": "done",
    });

    expect(screen.getByRole("button", { name: /Build the board/ })).toBeVisible();
    expect(screen.getByRole("button", { name: /Review the board/ })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /Forgotten session/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/1 older thread hidden/)).toBeVisible();
  });

  it("caps the unstaged column at 100 recent threads", async () => {
    const threads = Array.from({ length: 120 }, (_, index) => ({
      ...THREAD,
      id: `thread-${index}`,
      title: `Session ${index}`,
      updatedAt: new Date(Date.now() - index * 60_000).toISOString(),
    }));
    const registration = collectExtensionApp(kanbanApp).panels[0]!;
    const Component = registration.component;
    render(
      <Component
        extensionId="falcondeck.thread-tags"
        threads={threads}
        views={[]}
        hasPermission={(permission) => permission === "threads:read"}
        invokeAction={boardInvokeAction({})}
        openThread={vi.fn()}
      />,
    );

    const column = await screen.findByRole("region", { name: "No stage" });
    await screen.findByRole("button", { name: /Session 0/ });
    expect(column.querySelectorAll("button").length).toBe(100);
    expect(screen.getByText(/20 older threads hidden/)).toBeVisible();
  });

  it("filters the board by project", async () => {
    const otherProject = {
      ...OTHER_THREAD,
      workspaceId: "workspace-2",
    };
    await renderBoard(
      [THREAD, otherProject],
      { "thread-1": "backlog", "thread-2": "done" },
      vi.fn(),
      WORKSPACES,
    );

    const chip = screen.getByRole("button", { name: "falcondeck" });
    fireEvent.click(chip);
    expect(
      screen.queryByRole("button", { name: /Review the board/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Build the board/ })).toBeVisible();
    expect(
      window.localStorage.getItem("falcondeck.kanban.project-filter"),
    ).toBe("workspace-1");

    fireEvent.click(chip);
    expect(
      screen.getByRole("button", { name: /Review the board/ }),
    ).toBeVisible();
  });

  it("omits the project bar when only one project has threads", async () => {
    await renderBoard(
      [THREAD],
      { "thread-1": "backlog" },
      vi.fn(),
      WORKSPACES,
    );
    expect(
      screen.queryByRole("toolbar", { name: "Filter by project" }),
    ).not.toBeInTheDocument();
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

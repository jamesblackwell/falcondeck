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

const OTHER_THREAD = {
  ...THREAD,
  id: "thread-2",
  title: "Review the board",
};

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
) {
  const registration = collectExtensionApp(kanbanApp).panels[0]!;
  const Component = registration.component;
  const invokeAction = boardInvokeAction(threadStages);
  render(
    <Component
      extensionId="falcondeck.thread-tags"
      threads={threads}
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

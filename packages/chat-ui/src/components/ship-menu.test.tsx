import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ThreadSummary } from "@falcondeck/client-core";

import { ShipMenu } from "./ship-menu";

function thread(overrides: Partial<ThreadSummary> = {}): ThreadSummary {
  return {
    id: "thread-1",
    workspace_id: "workspace-1",
    title: "Add the merge button",
    provider: "codex",
    status: "idle",
    updated_at: "2026-08-17T10:00:00Z",
    last_message_preview: null,
    latest_turn_id: null,
    latest_plan: null,
    latest_diff: null,
    last_tool: null,
    last_error: null,
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
    is_archived: false,
    is_pinned: false,
    goal: null,
    queued_turns: [],
    variant: null,
    ...overrides,
  };
}

const isolated = thread({
  variant: {
    slug: "89070c86",
    path: "/Users/qa/.falcondeck/variants/demo/89070c86",
    branch: "falcondeck/89070c86",
    kind: "worktree",
    base_branch: "main",
  },
});

describe("ShipMenu", () => {
  it("stays hidden for same-folder threads", () => {
    const view = render(<ShipMenu thread={thread()} onShip={vi.fn()} />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it("stays hidden when no thread is selected", () => {
    const view = render(<ShipMenu thread={null} onShip={vi.fn()} />);
    expect(view.container).toBeEmptyDOMElement();
  });

  it("opens a pull request on the default click, not a merge", () => {
    const onShip = vi.fn();
    render(<ShipMenu thread={isolated} onShip={onShip} />);

    fireEvent.click(screen.getByRole("button", { name: /Merge$/ }));

    expect(onShip).toHaveBeenCalledWith("pr");
  });

  it("fires the mode chosen from the menu", () => {
    const onShip = vi.fn();
    render(<ShipMenu thread={isolated} onShip={onShip} />);

    fireEvent.click(screen.getByRole("button", { name: "Merge options" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Draft pull request/ }));

    expect(onShip).toHaveBeenCalledWith("draft_pr");
  });

  it("names the branch it would land", () => {
    render(<ShipMenu thread={isolated} onShip={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Merge options" }));

    expect(screen.getByText("falcondeck/89070c86")).toBeVisible();
  });

  it("disables merging into a dirty project folder and says why", () => {
    const onShip = vi.fn();
    render(<ShipMenu thread={isolated} onShip={onShip} projectFolderDirty />);

    fireEvent.click(screen.getByRole("button", { name: "Merge options" }));
    const merge = screen.getByRole("menuitem", { name: /Merge and push/ });

    expect(merge).toBeDisabled();
    expect(merge).toHaveTextContent("Your project folder has uncommitted changes");
    // Pull requests are still fine: they never write to the project folder.
    expect(screen.getByRole("menuitem", { name: /Create pull request/ })).toBeEnabled();
  });

  it("disables the whole control while a ship is in flight", () => {
    const onShip = vi.fn();
    render(<ShipMenu thread={isolated} onShip={onShip} pending />);

    expect(screen.getByRole("button", { name: /Merge$/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Merge options" })).toBeDisabled();
  });
});

import { act, render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { GitStatusResponse, ShipThreadMode, ThreadSummary } from "@falcondeck/client-core";

import { useShipThread, type UseShipThreadOptions } from "./use-ship-thread";

const variant = {
  slug: "89070c86",
  path: "/Users/qa/.falcondeck/variants/demo/89070c86",
  branch: "falcondeck/89070c86",
  kind: "worktree" as const,
  base_branch: "main",
};

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
    variant,
    ...overrides,
  };
}

function cleanStatus(): GitStatusResponse {
  return { branch: "main", entries: [] };
}

/** Renders the hook and hands its live result back to the test. */
function setup(options: Partial<UseShipThreadOptions> = {}) {
  const result = { current: null as ReturnType<typeof useShipThread> | null };
  const api = {
    gitStatus: vi.fn().mockResolvedValue(cleanStatus()),
    shipThread: vi.fn().mockResolvedValue({
      mode: "pr" as ShipThreadMode,
      branch: variant.branch,
      base: "main",
      committed: true,
      pushed: true,
      url: "https://github.com/example/repo/pull/7",
    }),
  };
  const toast = vi.fn();
  const openUrl = vi.fn().mockResolvedValue(undefined);

  function Probe() {
    result.current = useShipThread({
      api,
      workspaceId: "workspace-1",
      thread: thread(),
      toast,
      openUrl,
      ...options,
    });
    return null;
  }

  render(<Probe />);
  return { result, api, toast, openUrl };
}

describe("useShipThread", () => {
  it("reports a successful pull request and opens it", async () => {
    const { result, api, toast, openUrl } = setup();

    await act(async () => {
      await result.current?.ship("pr");
    });

    expect(api.shipThread).toHaveBeenCalledWith("workspace-1", "thread-1", "pr");
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "success", title: "Pull request created" }),
    );
    expect(openUrl).toHaveBeenCalledWith("https://github.com/example/repo/pull/7");
  });

  it("says a leftover commit happened first", async () => {
    const { result, toast } = setup();

    await act(async () => {
      await result.current?.ship("pr");
    });

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining("Committed leftover changes"),
      }),
    );
  });

  it("does not claim a push that failed after a local merge", async () => {
    const api = {
      gitStatus: vi.fn().mockResolvedValue(cleanStatus()),
      shipThread: vi.fn().mockResolvedValue({
        mode: "merge" as ShipThreadMode,
        branch: variant.branch,
        base: "main",
        committed: false,
        pushed: false,
        url: null,
      }),
    };
    const { result, toast } = setup({ api });

    await act(async () => {
      await result.current?.ship("merge");
    });

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "warning",
        description: expect.stringContaining("could not push to origin"),
      }),
    );
  });

  it("surfaces the daemon's refusal instead of a generic failure", async () => {
    const api = {
      gitStatus: vi.fn().mockResolvedValue(cleanStatus()),
      shipThread: vi
        .fn()
        .mockRejectedValue(new Error("the project folder has uncommitted changes")),
    };
    const { result, toast } = setup({ api });

    await act(async () => {
      await result.current?.ship("merge");
    });

    expect(toast).toHaveBeenCalledWith({
      variant: "danger",
      title: "Could not merge",
      description: "the project folder has uncommitted changes",
    });
  });

  it("asks about the project folder, not the isolated checkout", async () => {
    const { api } = setup();

    await waitFor(() => expect(api.gitStatus).toHaveBeenCalled());
    // A thread id would report the variant's own checkout, which is always
    // allowed to be dirty; merge cares about the project folder.
    expect(api.gitStatus).toHaveBeenCalledWith("workspace-1");
  });

  it("flags a dirty project folder so the menu can disable merging", async () => {
    const api = {
      gitStatus: vi.fn().mockResolvedValue({
        branch: "main",
        entries: [{ path: "src/main.rs", status: "modified", insertions: 2, deletions: 0 }],
      }),
      shipThread: vi.fn(),
    };
    const { result } = setup({ api });

    await waitFor(() => expect(result.current?.projectFolderDirty).toBe(true));
  });

  it("does not flag a dirty folder for same-folder threads", async () => {
    const { result, api } = setup({ thread: thread({ variant: null }) });

    await waitFor(() => expect(result.current?.projectFolderDirty).toBe(false));
    expect(api.gitStatus).not.toHaveBeenCalled();
  });
});

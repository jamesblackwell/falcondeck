import { describe, expect, it, vi } from "vitest";

import type { DaemonSnapshot } from "@falcondeck/client-core";

import { HostConnection, mergeSnapshots, type HostView } from "./hosts";

function snapshot(
  workspaceId: string,
  extensionId: string,
  threadId: string,
  enabled = true,
): DaemonSnapshot {
  return {
    daemon: { version: "0.1.0", started_at: "2026-08-13T00:00:00Z" },
    preferences: {},
    workspaces: [{ id: workspaceId, path: `/${workspaceId}` }],
    threads: [
      {
        id: threadId,
        workspace_id: workspaceId,
        provider: "codex",
        title: threadId,
        updated_at: "2026-08-13T00:00:00Z",
      },
    ],
    interactive_requests: [],
    extensions: {
      catalog: [
        {
          id: extensionId,
          name: extensionId,
          version: "1.0.0",
          source: "bundled",
          bundled: true,
          enabled,
          status: enabled ? "active" : "disabled",
          contributes: {
            threadMenuActions: [],
            threadDecorations: [],
            sidebarFilters: [],
          },
          permissions: [],
        },
      ],
      views: [
        {
          extension_id: extensionId,
          view_id: "thread-state",
          scope: { kind: "thread", id: threadId },
          value: { labels: ["hot"] },
          updated_at: "2026-08-13T00:00:00Z",
        },
      ],
    },
  } as unknown as DaemonSnapshot;
}

describe("mergeSnapshots", () => {
  it("merges remote extension catalogs and thread-scoped views", () => {
    const local = snapshot("local-workspace", "example.local", "local-thread");
    const remote = snapshot(
      "remote-workspace",
      "example.remote",
      "remote-thread",
    );
    const hosts = [
      {
        id: "remote-host",
        name: "Remote",
        snapshot: remote,
      } as HostView,
    ];

    const merged = mergeSnapshots(local, hosts);

    expect(merged?.extensions.catalog.map((extension) => extension.id)).toEqual(
      ["example.local", "example.remote"],
    );
    expect(
      merged?.extensions.views.map((view) => [
        view.extension_id,
        view.scope?.id,
      ]),
    ).toEqual([
      ["example.local", "local-thread"],
      ["example.remote", "remote-thread"],
    ]);
  });

  it("keeps same-id extension state and views scoped to enabled daemons", () => {
    const local = snapshot(
      "local-workspace",
      "falcondeck.thread-tags",
      "local-thread",
      false,
    );
    const remote = snapshot(
      "remote-workspace",
      "falcondeck.thread-tags",
      "remote-thread",
    );

    const merged = mergeSnapshots(local, [
      {
        id: "remote-host",
        name: "Remote",
        snapshot: remote,
      } as HostView,
    ]);

    expect(merged?.extensions.catalog).toHaveLength(1);
    expect(merged?.extensions.catalog[0]?.enabled).toBe(true);
    expect(merged?.extensions.views.map((view) => view.scope?.id)).toEqual([
      "remote-thread",
    ]);

    const inverse = mergeSnapshots(
      snapshot("local-workspace", "falcondeck.thread-tags", "local-thread"),
      [
        {
          id: "remote-host",
          name: "Remote",
          snapshot: snapshot(
            "remote-workspace",
            "falcondeck.thread-tags",
            "remote-thread",
            false,
          ),
        } as HostView,
      ],
    );

    expect(inverse?.extensions.views.map((view) => view.scope?.id)).toEqual([
      "local-thread",
    ]);
  });
});

describe("HostConnection extension actions", () => {
  it("invokes the owning daemon and refreshes its snapshot", async () => {
    const remoteSnapshot = snapshot(
      "remote-workspace",
      "falcondeck.thread-tags",
      "remote-thread",
    );
    const rpc = vi.fn(async (method: string) => {
      if (method === "snapshot.current") return remoteSnapshot;
      return { result: null, updated_views: [] };
    });
    const onChange = vi.fn();
    const connection = new HostConnection(
      {
        id: "remote-host",
        name: "Remote",
        sshTarget: null,
        sshPort: null,
        relayUrl: "https://connect.example.test",
        enabled: true,
        session: null,
      },
      onChange,
      vi.fn(),
    );
    Reflect.set(connection, "client", { rpc });

    await connection
      .api()
      .invokeExtensionAction("falcondeck.thread-tags", "set-thread-tags", {
        target: { kind: "thread", id: "remote-thread" },
        input: { color: "red" },
      });

    expect(rpc).toHaveBeenNthCalledWith(1, "extensions.action.invoke", {
      extension_id: "falcondeck.thread-tags",
      action_id: "set-thread-tags",
      target: { kind: "thread", id: "remote-thread" },
      input: { color: "red" },
    });
    expect(rpc).toHaveBeenNthCalledWith(2, "snapshot.current", {});
    expect(connection.snapshot?.extensions.views).toEqual(
      remoteSnapshot.extensions.views,
    );
    expect(onChange).toHaveBeenCalled();
  });
});

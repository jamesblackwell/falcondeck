import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DaemonSnapshot, PersistedRemoteSession, ThreadDetail } from "@falcondeck/client-core";

import {
  HostConnection,
  loadStoredHosts,
  mergeSnapshots,
  saveStoredHosts,
  type HostView,
} from "./hosts";

beforeEach(() => window.localStorage.clear());

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

  it("does not overwrite local token usage when a restored host reuses a thread id", () => {
    const local = snapshot("local-workspace", "example.local", "same-thread");
    const remote = snapshot("remote-workspace", "example.remote", "same-thread");
    local.thread_token_usage = {
      "same-thread": { total_tokens: 10 },
    } as DaemonSnapshot["thread_token_usage"];
    remote.thread_token_usage = {
      "same-thread": { total_tokens: 999 },
    } as DaemonSnapshot["thread_token_usage"];

    const merged = mergeSnapshots(local, [
      { id: "remote-host", snapshot: remote } as HostView,
    ]);

    expect(merged?.thread_token_usage["same-thread"]?.total_tokens).toBe(10);
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

  it("does not restore a stale snapshot after the host is stopped", async () => {
    const remoteSnapshot = snapshot(
      "remote-workspace",
      "falcondeck.thread-tags",
      "remote-thread",
    );
    let resolveSnapshot!: (value: DaemonSnapshot) => void;
    const snapshotResponse = new Promise<DaemonSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    });
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
      vi.fn(),
      vi.fn(),
    );
    Reflect.set(connection, "client", {
      rpc: vi.fn(() => snapshotResponse),
      stop: vi.fn(),
    });

    const refresh = connection.refresh();
    connection.stop();
    resolveSnapshot(remoteSnapshot);
    await refresh;

    expect(connection.snapshot).toBeNull();
  });

  it("surfaces malformed stored credentials as a repair state instead of crashing", () => {
    const onPersist = vi.fn();
    const connection = new HostConnection(
      {
        id: "remote-host",
        name: "Remote",
        sshTarget: null,
        sshPort: null,
        relayUrl: "https://connect.example.test",
        enabled: true,
        session: {
          version: 2,
          relayUrl: "https://connect.example.test",
          pairingCode: "",
          pairingId: "pairing-1",
          sessionId: "session-1",
          deviceId: "device-1",
          clientToken: "client-token",
          clientSecretKey: "not-a-valid-secret-key",
          daemonPublicKey: null,
          daemonIdentityPublicKey: null,
          dataKey: null,
          lastReceivedSeq: 0,
        },
      },
      vi.fn(),
      onPersist,
    );

    expect(() => connection.start()).not.toThrow();
    expect(connection.view()).toMatchObject({
      paired: true,
      needsRepair: true,
      status: "idle",
      lastError: expect.any(String),
    });
    expect(onPersist).toHaveBeenCalled();
  });
});

describe("desktop host credential persistence", () => {
  it("keeps remote session secrets out of localStorage", () => {
    const session = {
      sessionId: "session-1",
      clientToken: "token-that-must-not-be-durable",
      clientSecretKey: "secret-key-that-must-not-be-durable",
      dataKey: "data-key-that-must-not-be-durable",
    } as unknown as PersistedRemoteSession;

    saveStoredHosts([
      {
        id: "host-1",
        name: "Remote",
        sshTarget: null,
        sshPort: null,
        relayUrl: "https://connect.example.test",
        enabled: true,
        session,
      },
    ]);

    const raw = window.localStorage.getItem("falcondeck.desktop.hosts.v1") ?? "";
    expect(raw).toContain('"hasSession":true');
    expect(raw).not.toContain("token-that-must-not-be-durable");
    expect(raw).not.toContain("secret-key-that-must-not-be-durable");
    expect(raw).not.toContain("data-key-that-must-not-be-durable");
    expect(loadStoredHosts()[0]).toMatchObject({
      id: "host-1",
      session: null,
      hasStoredSession: true,
    });
  });
});

describe("HostConnection detail cache", () => {
  it("evicts the least recently used transcript after fifty entries", () => {
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
      vi.fn(),
      vi.fn(),
    );
    const detail = (index: number) =>
      ({
        workspace: { id: "workspace" },
        thread: { id: `thread-${index}` },
        items: [],
      }) as unknown as ThreadDetail;

    for (let index = 0; index < 50; index += 1) {
      connection.seedThreadDetail(detail(index));
    }
    expect(connection.cachedThreadDetail("workspace", "thread-0")).not.toBeNull();
    connection.seedThreadDetail(detail(50));

    expect(connection.cachedThreadDetail("workspace", "thread-0")).not.toBeNull();
    expect(connection.cachedThreadDetail("workspace", "thread-1")).toBeNull();
    expect(connection.cachedThreadDetail("workspace", "thread-50")).not.toBeNull();
  });
});

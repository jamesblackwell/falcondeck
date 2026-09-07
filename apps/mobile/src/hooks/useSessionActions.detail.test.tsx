import React from "react";
import { act } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { useRelayStore, useSessionStore } from "@/store";
import { assistantMessage, snapshot, snapshotEvent, threadDetail } from "@/test/factories";
import { cleanup, renderComponent } from "@/test/render";
import { useSessionActions } from "./useSessionActions";
import { createRelayTranscriptRecovery } from "./relay-transcript-recovery";

let actions: ReturnType<typeof useSessionActions>;
function Harness() {
  const current = useSessionActions();
  React.useEffect(() => { actions = current; }, [current]);
  return null;
}
function deferredDetail() {
  let resolve!: (detail: ReturnType<typeof threadDetail>) => void;
  const promise = new Promise<ReturnType<typeof threadDetail>>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  useSessionStore.getState().reset();
  useSessionStore.getState().applyDaemonEvent(snapshotEvent(snapshot()));
  useSessionStore.getState().selectThread("workspace-1", "thread-1");
  useRelayStore.setState({ sessionId: "session-1", _setError: vi.fn() });
  useRelayStore.getState()._setSocket(null);
  renderComponent(<Harness />);
});
afterEach(() => {
  cleanup();
  useRelayStore.getState()._setSocket(null);
  useRelayStore.getState()._setSessionCrypto(null);
  vi.restoreAllMocks();
});

it("shares repeated foreground tail loads instead of transferring the page twice", async () => {
  const deferred = deferredDetail();
  const rpc = vi.fn().mockReturnValue(deferred.promise);
  useRelayStore.setState({ _callRpc: rpc });

  await act(async () => {
    const first = actions.loadThreadDetail("workspace-1", "thread-1");
    const repeated = actions.loadThreadDetail("workspace-1", "thread-1");
    const requestsStarted = rpc.mock.calls.length;
    deferred.resolve(threadDetail({ items: [assistantMessage("latest", "hello")] }));
    await Promise.all([first, repeated]);
    expect(requestsStarted).toBe(1);
  });
  expect(useSessionStore.getState().threadItems["thread-1"]?.[0]?.id).toBe("latest");

  await act(async () => { await actions.loadThreadDetail("workspace-1", "thread-1"); });
  expect(rpc).toHaveBeenCalledTimes(2);
});

it("starts a fresh tail request after the socket changes and ignores the old result", async () => {
  const old = deferredDetail();
  const current = deferredDetail();
  const rpc = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
  useRelayStore.setState({ _callRpc: rpc });

  await act(async () => {
    const first = actions.loadThreadDetail("workspace-1", "thread-1");
    useRelayStore.getState()._setSocket({ readyState: 1 } as WebSocket);
    const second = actions.loadThreadDetail("workspace-1", "thread-1");
    expect(rpc).toHaveBeenCalledTimes(2);
    current.resolve(threadDetail({ items: [assistantMessage("current", "fresh")] }));
    await second;
    old.resolve(threadDetail({ items: [assistantMessage("old", "stale")] }));
    expect(await first).toBeNull();
  });
  expect(useSessionStore.getState().threadItems["thread-1"]?.[0]?.id).toBe("current");
});

it("does not publish a completed page after its socket was retired", async () => {
  const old = deferredDetail();
  const setError = vi.fn();
  useRelayStore.setState({ _callRpc: vi.fn().mockReturnValue(old.promise), _setError: setError });

  await act(async () => {
    const pending = actions.loadThreadDetail("workspace-1", "thread-1");
    useRelayStore.getState()._setSocket({ readyState: 1 } as WebSocket);
    old.resolve(threadDetail({ items: [assistantMessage("old", "stale")] }));
    expect(await pending).toBeNull();
  });
  expect(useSessionStore.getState().threadItems["thread-1"]).toBeUndefined();
  expect(setError).not.toHaveBeenCalled();
});

it("does not let an older foreground load overwrite a repaired transcript", async () => {
  const old = deferredDetail();
  const rpc = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValueOnce(
    threadDetail({ items: [assistantMessage("reply", "complete")] }),
  );
  useRelayStore.setState({ _callRpc: rpc, machinePresence: {
    session_id: "session-1", daemon_connected: true, daemon_rpc_ready: true, last_seen_at: null,
  } });
  useRelayStore.getState()._setSocket({ readyState: 1 } as WebSocket);
  useRelayStore.getState()._setSessionCrypto({ dataKey: new Uint8Array(32), material: null });
  const recovery = createRelayTranscriptRecovery();
  try {
    await act(async () => {
      const foreground = actions.loadThreadDetail("workspace-1", "thread-1");
      recovery.invalidate();
      recovery.snapshotApplied();
      await Promise.resolve();
      old.resolve(threadDetail({ items: [assistantMessage("reply", "partial")] }));
      await foreground;
    });
    expect(useSessionStore.getState().threadItems["thread-1"]).toMatchObject([
      { id: "reply", text: "complete" },
    ]);
  } finally {
    recovery.cancel();
  }
});

it("starts a fresh foreground retry instead of sharing a page superseded by recovery", async () => {
  const oldForeground = deferredDetail();
  const oldRecovery = deferredDetail();
  const rpc = vi.fn()
    .mockReturnValueOnce(oldForeground.promise)
    .mockReturnValueOnce(oldRecovery.promise)
    .mockResolvedValueOnce(threadDetail({ items: [assistantMessage("reply", "latest")] }));
  useRelayStore.setState({ _callRpc: rpc, machinePresence: {
    session_id: "session-1", daemon_connected: true, daemon_rpc_ready: true, last_seen_at: null,
  } });
  useRelayStore.getState()._setSocket({ readyState: 1 } as WebSocket);
  useRelayStore.getState()._setSessionCrypto({ dataKey: new Uint8Array(32), material: null });
  const recovery = createRelayTranscriptRecovery();
  try {
    await act(async () => {
      const first = actions.loadThreadDetail("workspace-1", "thread-1");
      recovery.invalidate();
      recovery.snapshotApplied();
      await actions.loadThreadDetail("workspace-1", "thread-1");
      oldForeground.resolve(threadDetail({ items: [assistantMessage("reply", "partial")] }));
      oldRecovery.resolve(threadDetail({ items: [assistantMessage("reply", "outdated repair")] }));
      await first;
    });
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(useSessionStore.getState().threadItems["thread-1"]).toMatchObject([
      { id: "reply", text: "latest" },
    ]);
  } finally {
    recovery.cancel();
  }
});

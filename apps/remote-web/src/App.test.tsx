import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  bytesToBase64,
  decryptJson,
  encryptJson,
  generateBoxKeyPair,
  normalizeDaemonSnapshot,
  REMOTE_SESSION_STORAGE_VERSION,
  secretKeyToBase64,
} from "@falcondeck/client-core";

import App from "./App";
import { persistRemoteSession } from "./lib/remoteAppUtils";
import hermes from '../../../packages/client-core/src/test-fixtures/hermes.json';

class TestWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: TestWebSocket[] = [];

  readyState = TestWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = TestWebSocket.CLOSED;
  });

  constructor(readonly url: string) {
    TestWebSocket.instances.push(this);
  }
}

function sentRelayMessages(socket: TestWebSocket) {
  return socket.send.mock.calls.map(([payload]) => JSON.parse(payload as string));
}

async function renderConnectedSession() {
  TestWebSocket.instances = [];
  vi.stubGlobal("WebSocket", TestWebSocket);
  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({ ticket: "test-ticket" }),
  } as Response);
  persistRemoteSession({
    version: REMOTE_SESSION_STORAGE_VERSION,
    relayUrl: "https://connect.example.com",
    pairingCode: "ABCD1234",
    sessionId: "session-connectivity",
    clientToken: "client-token",
    clientSecretKey: secretKeyToBase64(generateBoxKeyPair()),
    dataKey: bytesToBase64(new Uint8Array(32).fill(7)),
  });

  render(<App />);
  await vi.waitFor(() => expect(TestWebSocket.instances).toHaveLength(1));
  const socket = TestWebSocket.instances[0]!;
  act(() => {
    socket.readyState = TestWebSocket.OPEN;
    socket.onopen?.();
  });
  return socket;
}

function sendOnlineSync(socket: TestWebSocket, updates: unknown[] = []) {
  act(() => {
    socket.onmessage?.({
      data: JSON.stringify({
        type: "sync",
        next_seq: 7,
        history_truncated: false,
        presence: {
          session_id: "session-connectivity",
          daemon_connected: true,
          daemon_rpc_ready: true,
          last_seen_at: null,
        },
        updates,
      }),
    });
  });
}

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.title = "";
});

describe("App", () => {
  it("recovers a pending Hermes approval after replay pruning and sends its exact choice", async () => {
    const socket = await renderConnectedSession();
    const dataKey = new Uint8Array(32).fill(7);
    vi.mocked(fetch).mockImplementation(async (input) => ({
      ok: true,
      json: async () => String(input).includes('/actions')
        ? { action_id: 'hermes-answer', status: 'completed', result: await encryptJson(dataKey, { ok: true }) }
        : { ticket: 'test-ticket' },
    } as Response));
    const calls = (method: string) => sentRelayMessages(socket).filter(message => message.type === 'rpc-call' && message.method === method);
    const reply = async (method: string, result: unknown) => {
      await waitFor(() => expect(calls(method).length).toBeGreaterThan(0));
      const payload = await encryptJson(dataKey, result);
      act(() => socket.onmessage?.({ data: JSON.stringify({ type: 'rpc-result', request_id: calls(method).at(-1).request_id, ok: true, result: payload }) }));
    };
    const base = normalizeDaemonSnapshot({
      workspaces: [{ id: 'hermes-workspace', path: '/workspace/hermes', default_provider: 'hermes', agents: [hermes.agent], current_thread_id: 'hermes-thread' }],
      threads: [{ ...hermes.thread, status: 'idle' }], interactive_requests: [],
    });
    sendOnlineSync(socket);
    await reply('snapshot.current', base);
    await screen.findByRole('button', { name: 'Hermes fixture' });
    fireEvent.click(screen.getByRole('button', { name: 'Hermes fixture' }));
    await reply('thread.detail', { workspace_id: 'hermes-workspace', thread: hermes.thread, items: [] });
    act(() => socket.onmessage?.({ data: JSON.stringify({
      type: 'sync', updates: [], next_seq: 40, history_truncated: true,
      presence: { session_id: 'session-connectivity', daemon_connected: true, daemon_rpc_ready: true, last_seen_at: null },
    }) }));
    await waitFor(() => expect(calls('snapshot.current')).toHaveLength(2));
    await reply('snapshot.current', { ...base, threads: [hermes.thread], interactive_requests: [hermes.request] });
    const allow = await screen.findByRole('button', { name: 'Allow edit' });
    expect(screen.getAllByText('hermes-allowed.txt').length).toBeGreaterThan(0);
    await act(async () => { fireEvent.click(allow); });
    const posts = () => vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input).endsWith('/actions') && init?.method === 'POST' && JSON.parse(init.body as string).action_type === 'interactive.respond');
    await waitFor(() => expect(posts()).toHaveLength(1));
    const action = JSON.parse(posts()[0]![1]!.body as string);
    expect(action.action_type).toBe('interactive.respond');
    expect(await decryptJson(dataKey, action.payload)).toMatchObject({
      workspace_id: 'hermes-workspace', request_id: 'hermes-permission',
      response: { kind: 'approval_option', option_id: 'allow_once' },
    });
    await waitFor(() => expect(allow).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }));
    const stops = () => vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input).endsWith('/actions') && init?.method === 'POST' && JSON.parse(init.body as string).action_type === 'turn.interrupt');
    await waitFor(() => expect(stops()).toHaveLength(1));
    const stop = JSON.parse(stops()[0]![1]!.body as string);
    expect(await decryptJson(dataKey, stop.payload)).toMatchObject({
      workspace_id: 'hermes-workspace', thread_id: 'hermes-thread',
    });
  });

  it("mounts on the pairing screen when nothing is stored", () => {
    render(<App />);
    expect(screen.getByLabelText("Alpha notice")).toHaveTextContent(
      "FalconDeck Remote is largely untested. We recommend the iOS or Mac app for primary use.",
    );
    expect(
      screen.getByRole("heading", { name: "FalconDeck Remote" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Secure pairing code")).toHaveValue("");
  });

  it("requires review before applying a code from a pairing link", () => {
    window.history.replaceState({}, "", "/?code=ABCD1234");
    render(<App />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "connect.falcondeck.com",
    );
    expect(screen.getByLabelText("Secure pairing code")).toHaveValue("");
    fireEvent.click(
      screen.getByRole("button", { name: "Use this pairing link" }),
    );
    expect(screen.getByLabelText("Secure pairing code")).toHaveValue("ABCD1234");
    window.history.replaceState({}, "", "/");
  });

  it("discards a stored session written by an older storage version", () => {
    window.localStorage.setItem(
      "falcondeck.remote.session.v1",
      JSON.stringify({ version: 0, sessionId: "stale" }),
    );
    render(<App />);
    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(
      window.localStorage.getItem("falcondeck.remote.session.v1"),
    ).toBeNull();
  });

  it("loads the command palette on the first shortcut without losing that request", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => new Promise<Response>(() => {}),
    );
    Element.prototype.scrollIntoView = vi.fn();
    persistRemoteSession({
      version: REMOTE_SESSION_STORAGE_VERSION,
      relayUrl: "https://connect.example.com",
      pairingCode: "ABCD1234",
      sessionId: "session-command-palette",
      clientToken: "client-token",
      clientSecretKey: secretKeyToBase64(generateBoxKeyPair()),
    });

    render(<App />);
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "k", metaKey: true });

    expect(
      await screen.findByRole("dialog", { name: "Command palette" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Search threads and commands" }),
    ).toHaveFocus();
  });

  it("retries a rejected authoritative snapshot exactly once after the first backoff", async () => {
    vi.useFakeTimers();
    const socket = await renderConnectedSession();
    sendOnlineSync(socket);

    await vi.waitFor(() => {
      expect(
        sentRelayMessages(socket).filter(
          (message) =>
            message.type === "rpc-call" && message.method === "snapshot.current",
        ),
      ).toHaveLength(1);
    });
    const firstRequest = sentRelayMessages(socket).find(
      (message) => message.type === "rpc-call" && message.method === "snapshot.current",
    );

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: "rpc-result",
          request_id: firstRequest.request_id,
          ok: false,
          failure: "responder_disconnected",
        }),
      });
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(
      sentRelayMessages(socket).filter((message) => message.method === "snapshot.current"),
    ).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    await vi.waitFor(() => {
      expect(
        sentRelayMessages(socket).filter((message) => message.method === "snapshot.current"),
      ).toHaveLength(2);
    });
  });

  it("keeps authoritative sync presence when replay contains an older offline state", async () => {
    let flushFrame: FrameRequestCallback | null = null;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        flushFrame = callback;
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const socket = await renderConnectedSession();

    sendOnlineSync(socket, [
      {
        id: "stale-presence",
        seq: 6,
        created_at: "2026-08-21T07:00:00Z",
        body: {
          t: "presence",
          presence: {
            session_id: "session-connectivity",
            daemon_connected: false,
            daemon_rpc_ready: false,
            last_seen_at: "2026-08-21T06:59:00Z",
          },
        },
      },
    ]);
    await act(async () => {
      flushFrame?.(performance.now());
      await Promise.resolve();
    });

    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.queryByText("Desktop retrying")).not.toBeInTheDocument();
  });
});

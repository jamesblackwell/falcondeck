import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import { useControlStateEvents } from "./useControlStateEvents";

type Frame = { data: string };

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  onmessage: ((message: Frame) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;

  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.unstubAllGlobals();
});

describe("useControlStateEvents", () => {
  it("connects to the events stream and forwards control changes", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onChange = vi.fn();
    renderHook(() => useControlStateEvents("http://127.0.0.1:4123", onChange));

    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0].url).toBe("ws://127.0.0.1:4123/api/events");

    act(() => {
      FakeWebSocket.instances[0].emit({
        seq: 1,
        emitted_at: "2026-08-16T14:22:10Z",
        workspace_id: null,
        thread_id: null,
        event: {
          type: "control-state-changed",
          change: { store_revision: 42, domains: ["automations"] },
        },
      });
    });
    expect(onChange).toHaveBeenCalledWith(42, ["automations"]);
  });

  it("ignores other frames and malformed payloads", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const onChange = vi.fn();
    renderHook(() => useControlStateEvents("http://127.0.0.1:4123", onChange));
    const socket = FakeWebSocket.instances[0];

    act(() => {
      socket.emit({
        seq: 2,
        emitted_at: "2026-08-16T14:22:11Z",
        workspace_id: null,
        thread_id: null,
        event: { type: "thread-updated", thread: null },
      });
      socket.onmessage?.({ data: "{not json" });
      socket.emit({
        seq: 3,
        emitted_at: "2026-08-16T14:22:12Z",
        workspace_id: null,
        thread_id: null,
        event: { type: "control-state-changed", change: { domains: [] } },
      });
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("closes the socket on unmount and survives missing WebSocket", () => {
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const { unmount } = renderHook(() =>
      useControlStateEvents("http://127.0.0.1:4123", vi.fn()),
    );
    unmount();
    expect(FakeWebSocket.instances[0].closed).toBe(true);

    // A missing implementation (jsdom without WebSocket) must not throw.
    vi.stubGlobal("WebSocket", undefined);
    expect(() =>
      renderHook(() => useControlStateEvents("http://127.0.0.1:4123", vi.fn())),
    ).not.toThrow();
  });
});

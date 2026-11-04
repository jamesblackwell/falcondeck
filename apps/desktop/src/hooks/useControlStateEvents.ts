import { useEffect, useRef } from "react";

import { normalizeEventEnvelope } from "@falcondeck/client-core";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * Subscribes to the daemon's unified event stream while the caller is
 * mounted and invokes `onChange` for every `control-state-changed` frame.
 *
 * MCP-originated automation changes then appear in the interface without a
 * restart or polling. The socket is scoped to the panel: it opens on mount and
 * closes on unmount. A dropped socket reconnects with backoff, because sleep
 * and daemon restarts drop it and nothing else would tell the review inbox
 * that a review arrived. `onReconnect` lets the caller catch up on what it
 * missed while the socket was down.
 */
export function useControlStateEvents(
  baseUrl: string | null,
  onChange: (storeRevision: number, domains: string[]) => void,
  onReconnect?: () => void,
): void {
  const handlerRef = useRef(onChange);
  const reconnectRef = useRef(onReconnect);
  // Kept current in an effect, not during render: the socket only delivers
  // messages after mount, so the latest handler is always in place by then.
  useEffect(() => {
    handlerRef.current = onChange;
    reconnectRef.current = onReconnect;
  }, [onChange, onReconnect]);

  useEffect(() => {
    if (!baseUrl) return;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let disposed = false;
    let dropped = false;
    let delay = RECONNECT_BASE_MS;

    const connect = () => {
      let next: WebSocket;
      try {
        next = new WebSocket(baseUrl.replace(/^http/, "ws") + "/api/events");
      } catch {
        // A missing WebSocket implementation (tests) must never break the
        // panel; it simply falls back to its own loads.
        return;
      }
      socket = next;
      next.onopen = () => {
        delay = RECONNECT_BASE_MS;
        if (dropped) {
          dropped = false;
          reconnectRef.current?.();
        }
      };
      next.onclose = () => {
        if (disposed || socket !== next) return;
        dropped = true;
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, RECONNECT_MAX_MS);
      };
      next.onmessage = (message) => {
        let envelope: unknown;
        try {
          envelope = JSON.parse(String(message.data));
        } catch {
          return;
        }
        const normalized = normalizeEventEnvelope(envelope);
        if (
          normalized &&
          normalized.event.type === "control-state-changed" &&
          typeof normalized.event.change.store_revision === "number"
        ) {
          handlerRef.current(
            normalized.event.change.store_revision,
            Array.isArray(normalized.event.change.domains)
              ? normalized.event.change.domains
              : [],
          );
        }
      };
    };

    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [baseUrl]);
}

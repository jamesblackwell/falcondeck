import { useEffect, useRef } from "react";

import { normalizeEventEnvelope } from "@falcondeck/client-core";

/**
 * Subscribes to the daemon's unified event stream while the caller is
 * mounted and invokes `onChange` for every `control-state-changed` frame.
 *
 * MCP-originated automation changes then appear in the interface without a
 * restart or polling. The socket is intentionally scoped to the panel: it
 * opens on mount and closes on unmount, and any connection failure is
 * silent — the panels still work from their own loads.
 */
export function useControlStateEvents(
  baseUrl: string | null,
  onChange: (storeRevision: number, domains: string[]) => void,
): void {
  const handlerRef = useRef(onChange);
  handlerRef.current = onChange;

  useEffect(() => {
    if (!baseUrl) return;
    let socket: WebSocket | null = null;
    try {
      socket = new WebSocket(baseUrl.replace(/^http/, "ws") + "/api/events");
    } catch {
      // A missing WebSocket implementation (tests) must never break the
      // panel; it simply falls back to its own loads.
      return;
    }
    socket.onmessage = (message) => {
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
    return () => {
      socket?.close();
    };
  }, [baseUrl]);
}

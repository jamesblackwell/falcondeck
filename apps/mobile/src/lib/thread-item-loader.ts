/**
 * On-demand full conversation items.
 *
 * Mobile thread pages arrive trimmed: image previews are references instead of
 * inline data URLs and long tool output is cut at a few KB (see
 * `MOBILE_THREAD_DETAIL_OPTIONS`). This module fetches the full item through
 * the `thread.item` RPC when a renderer actually needs it — an image scrolled
 * into view, a tool card expanded — and swaps it into the transcript.
 *
 * Fetches are deduplicated per item and the resolved items are kept in a small
 * in-memory cache so re-opening a thread (which re-applies a trimmed page)
 * restores what the reader already saw without another round trip.
 */
import { useCallback, useEffect, useSyncExternalStore } from "react";

import {
  isSafeMediaUrl,
  normalizeConversationItem,
  type ConversationItem,
} from "@falcondeck/client-core";

import { isDemoSession } from "@/features/demo/demoRpc";
import { useRelayStore, useSessionStore } from "@/store";

type ToolCallItem = Extract<ConversationItem, { kind: "tool_call" }>;
type ImageItem = Extract<ConversationItem, { kind: "image" }>;

export type FullItemStatus = "idle" | "loading" | "ready" | "error";

const RESOLVED_CACHE_LIMIT = 48;
const MAX_CONCURRENT_ITEM_LOADS = 2;

const inflight = new Map<string, Promise<ConversationItem | null>>();
const resolved = new Map<string, ConversationItem>();
const failed = new Set<string>();
const listeners = new Set<() => void>();
let transferSlots = { scope: "", active: 0, waiting: [] as (() => void)[] };

function key(
  relayUrl: string,
  sessionId: string | null,
  workspaceId: string,
  threadId: string,
  itemId: string,
) {
  return JSON.stringify([relayUrl, sessionId, workspaceId, threadId, itemId]);
}

function acquireTransferSlot(slots: typeof transferSlots): Promise<void> {
  if (slots.active < MAX_CONCURRENT_ITEM_LOADS) {
    slots.active += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => slots.waiting.push(resolve));
}

function releaseTransferSlot(slots: typeof transferSlots) {
  const next = slots.waiting.shift();
  if (next) next();
  else slots.active -= 1;
}

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function remember(cacheKey: string, item: ConversationItem) {
  resolved.delete(cacheKey);
  resolved.set(cacheKey, item);
  while (resolved.size > RESOLVED_CACHE_LIMIT) {
    const oldest = resolved.keys().next().value;
    if (oldest === undefined) break;
    resolved.delete(oldest);
  }
}

/** Whether a tool call's output was cut by the daemon page. */
export function toolOutputIsTruncated(item: ToolCallItem): boolean {
  return (item.display.output_total_bytes ?? 0) > 0;
}

/**
 * Whether an image reference must be fetched before it can render: no
 * renderable URL, but the daemon left a path or MIME type behind (a stripped
 * data URL keeps both). A bare empty URL with nothing else is simply
 * unavailable and never fetched.
 */
export function imageNeedsFetch(image: {
  url: string;
  local_path?: string | null;
  mime_type?: string | null;
}): boolean {
  const url = image.url.trim();
  if (url.length > 0 && isSafeMediaUrl(url, "image")) return false;
  const localPath = image.local_path?.trim() ?? "";
  // A stripped data URL leaves an empty URL beside its path/MIME hints; a
  // Codex "viewed image" carries the daemon-local path as its URL. Anything
  // else that is unsafe (a scheme we refuse, a credentialed remote URL) is
  // unavailable, not unfetched.
  if (url.length === 0) return Boolean(localPath || image.mime_type?.trim());
  return url.startsWith("/") && url === localPath;
}

/** Pure check used by renderers before subscribing to a fetch. */
export function imageItemNeedsFetch(item: ImageItem): boolean {
  return imageNeedsFetch(item.image);
}

function applyResolved(threadId: string, item: ConversationItem) {
  const session = useSessionStore.getState();
  const items = session.threadItems[threadId];
  if (!items) return;
  const current = items.find(
    (entry) => entry.id === item.id && entry.kind === item.kind,
  );
  // Only replace what a page actually delivered; upsert would append a
  // stale item to a thread that has since dropped it.
  if (!current || current === item) return;
  session.upsertLocalThreadItem(threadId, item);
}

/**
 * Fetches the full item once and swaps it into the transcript. Resolves to
 * the item (or null when the session changed underneath the request). Errors
 * are recorded for `useFullThreadItem` and re-thrown to the caller.
 */
export function loadFullThreadItem(
  workspaceId: string,
  threadId: string,
  itemId: string,
): Promise<ConversationItem | null> {
  const relay = useRelayStore.getState();
  if (!relay.sessionId || isDemoSession(relay.sessionId)) return Promise.resolve(null);
  const relaySessionId = relay.sessionId;
  const relayUrl = relay.relayUrl;
  const cacheKey = key(relayUrl, relaySessionId, workspaceId, threadId, itemId);
  const cached = resolved.get(cacheKey);
  if (cached) {
    applyResolved(threadId, cached);
    return Promise.resolve(cached);
  }
  const pending = inflight.get(cacheKey);
  if (pending) return pending;

  const scope = JSON.stringify([relayUrl, relaySessionId]);
  if (transferSlots.scope !== scope) {
    // Requests on the old pairing must not hold the new daemon's queue open.
    transferSlots = { scope, active: 0, waiting: [] };
  }
  const slots = transferSlots;
  const ownsSession = () => {
    const current = useRelayStore.getState();
    return current.sessionId === relaySessionId && current.relayUrl === relayUrl;
  };
  const request = (async () => {
    // Virtualized lists mount ahead of the viewport. Don't let a screenful of
    // multi-megabyte images consume every transfer slot at once.
    await acquireTransferSlot(slots);
    try {
      const session = useSessionStore.getState();
      if (!ownsSession() || session.selectedWorkspaceId !== workspaceId ||
          session.selectedThreadId !== threadId) return null;
      const item = normalizeConversationItem(
        await relay._callRpc<ConversationItem>(
          "thread.item",
          { workspace_id: workspaceId, thread_id: threadId, item_id: itemId },
          { requestIdPrefix: "mobile-item" },
        ),
      );
      if (!ownsSession()) return null;
      failed.delete(cacheKey);
      remember(cacheKey, item);
      applyResolved(threadId, item);
      return item;
    } catch (error) {
      if (ownsSession()) failed.add(cacheKey);
      throw error;
    } finally {
      releaseTransferSlot(slots);
      inflight.delete(cacheKey);
      notify();
    }
  })();
  inflight.set(cacheKey, request);
  notify();
  return request;
}

/** Test-only reset of module state. */
export function resetThreadItemLoaderForTests() {
  inflight.clear();
  resolved.clear();
  failed.clear();
  transferSlots = { scope: "", active: 0, waiting: [] };
}

function statusFor(cacheKey: string): FullItemStatus {
  if (inflight.has(cacheKey)) return "loading";
  if (resolved.has(cacheKey)) return "ready";
  if (failed.has(cacheKey)) return "error";
  return "idle";
}

/**
 * Subscribes a renderer to the full version of one transcript item. While
 * `needed` is true and the item is still trimmed, the fetch starts (once) and
 * the transcript updates in place when it lands. `retry` clears a failure.
 */
export function useFullThreadItem(
  itemId: string,
  needed: boolean,
): { status: FullItemStatus; retry: () => void } {
  const workspaceId = useSessionStore((state) => state.selectedWorkspaceId);
  const threadId = useSessionStore((state) => state.selectedThreadId);
  const sessionId = useRelayStore((state) => state.sessionId);
  const relayUrl = useRelayStore((state) => state.relayUrl);
  const cacheKey = workspaceId && threadId && sessionId
    ? key(relayUrl, sessionId, workspaceId, threadId, itemId)
    : null;
  const status = useSyncExternalStore(
    subscribe,
    () => (cacheKey ? statusFor(cacheKey) : "idle"),
    () => "idle" as FullItemStatus,
  );

  useEffect(() => {
    if (!needed || !workspaceId || !threadId || !cacheKey) return;
    if (failed.has(cacheKey)) return;
    loadFullThreadItem(workspaceId, threadId, itemId).catch(() => {
      // Surfaced through `status`; the renderer offers a retry.
    });
  }, [cacheKey, itemId, needed, threadId, workspaceId]);

  const retry = useCallback(() => {
    if (!workspaceId || !threadId || !cacheKey) return;
    failed.delete(cacheKey);
    notify();
    loadFullThreadItem(workspaceId, threadId, itemId).catch(() => {});
  }, [cacheKey, itemId, threadId, workspaceId]);

  return { status, retry };
}

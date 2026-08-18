import { useEffect, useRef, useSyncExternalStore } from "react";

import { ACTIVITY_TAIL_LINES, type ActivityTail } from "@falcondeck/client-core";

import { activityTailStore, threadTailKey } from "../activity-tails";
import type { WorkspaceScopedApi } from "../hosts";

/**
 * Declare which threads deserve a buffered tail, and fetch history for the
 * ones the app never saw start.
 *
 * Deliberately returns nothing. Tails change at token rate, and a hook that
 * handed them back would re-render whatever called it on every frame — which
 * is why the subscription lives in `useActivityTailSnapshot`, close to the
 * one component that paints them.
 */
export function useActivityTailTracking(
  keys: string[],
  apiFor: (workspaceId: string | null | undefined) => WorkspaceScopedApi | null,
  enabled: boolean,
) {
  const seedingRef = useRef(new Set<string>());
  const keyList = keys.join("|");

  useEffect(() => {
    activityTailStore.track(enabled ? keys : []);
    if (!enabled) {
      seedingRef.current.clear();
      return;
    }
    for (const key of keys) {
      if (!activityTailStore.needsSeed(key) || seedingRef.current.has(key)) {
        continue;
      }
      const separator = key.indexOf(":");
      const workspaceId = key.slice(0, separator);
      const threadId = key.slice(separator + 1);
      const client = apiFor(workspaceId);
      if (!client) continue;
      seedingRef.current.add(key);
      void client
        .threadDetail(workspaceId, threadId, { limit: ACTIVITY_TAIL_LINES * 2 })
        .then((detail) => activityTailStore.seed(key, detail.items))
        .catch(() => {
          // A tail is a courtesy. An unreachable host already reports itself
          // on the card's badge, and retrying per render would hammer it.
        })
        .finally(() => seedingRef.current.delete(key));
    }
    // `keyList` stands in for `keys`, whose identity changes every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiFor, enabled, keyList]);
}

/** Subscribe to the tails. Re-renders the caller at most once per frame. */
export function useActivityTailSnapshot(): Record<string, ActivityTail> {
  return useSyncExternalStore(
    activityTailStore.subscribe,
    activityTailStore.snapshot,
  );
}

export { threadTailKey };

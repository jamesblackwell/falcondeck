import {
  ACTIVITY_TAIL_LINES,
  applyEventToActivityTail,
  activityTailFromItems,
  appendOptimisticTailLine,
  EMPTY_ACTIVITY_TAIL,
  type ActivityTail,
  type ConversationItem,
  type EventEnvelope,
} from "@falcondeck/client-core";

/* ================================================================
   Activity tail store.

   One module-level store rather than a hook, because the two event
   sources are not React: the local daemon socket drains through
   useDaemonConnection, and every remote host drains through its own
   HostConnection. Both hand events here; Activity subscribes.

   The store only keeps threads Activity is currently showing. An app
   left open for a day sees events for hundreds of threads, and a
   dashboard of twelve has no use for the rest.
   ================================================================ */

export function threadTailKey(workspaceId: string, threadId: string) {
  return `${workspaceId}:${threadId}`;
}

export class ActivityTailStore {
  private tails = new Map<string, ActivityTail>();
  private tracked = new Set<string>();
  private listeners = new Set<() => void>();
  /** Rebuilt only when something changed, so useSyncExternalStore is stable. */
  private published: Record<string, ActivityTail> = {};
  private dirty = false;
  private notifyHandle: number | null = null;

  /**
   * Declare the threads worth buffering. Untracked keys are dropped, which is
   * also how a thread that leaves the queue releases its buffer.
   */
  track(keys: Iterable<string>) {
    const next = new Set(keys);
    let changed = next.size !== this.tracked.size;
    if (!changed) {
      for (const key of next) {
        if (!this.tracked.has(key)) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return;
    this.tracked = next;
    for (const key of [...this.tails.keys()]) {
      if (!next.has(key)) this.tails.delete(key);
    }
    this.markDirty();
  }

  isTracked(key: string) {
    return this.tracked.has(key);
  }

  /** Whether history still needs fetching for this thread. */
  needsSeed(key: string) {
    return this.tracked.has(key) && !this.tails.get(key)?.seeded;
  }

  seed(key: string, items: ConversationItem[]) {
    if (!this.tracked.has(key)) return;
    const seeded = activityTailFromItems(items);
    const live = this.tails.get(key);
    // Events that arrived while the fetch was in flight are newer than the
    // page it returned, so they win; the seed only fills in behind them.
    if (live && live.lines.length > 0) {
      const known = new Set(live.lines.map((line) => line.id));
      const merged = [
        ...seeded.lines.filter((line) => !known.has(line.id)),
        ...live.lines,
      ];
      this.tails.set(key, {
        seeded: true,
        lines: merged.slice(-ACTIVITY_TAIL_LINES),
      });
    } else {
      this.tails.set(key, seeded);
    }
    this.markDirty();
  }

  ingest(events: readonly EventEnvelope[]) {
    for (const event of events) {
      if (!event.workspace_id || !event.thread_id) continue;
      const key = threadTailKey(event.workspace_id, event.thread_id);
      if (!this.tracked.has(key)) continue;
      const current = this.tails.get(key) ?? EMPTY_ACTIVITY_TAIL;
      const next = applyEventToActivityTail(current, event);
      if (next === current) continue;
      this.tails.set(key, next);
      this.dirty = true;
    }
    if (this.dirty) this.markDirty();
  }

  /** Show a just-sent message before the daemon echoes it back. */
  appendOptimistic(key: string, itemId: string, text: string) {
    if (!this.tracked.has(key)) return;
    this.tails.set(
      key,
      appendOptimisticTailLine(
        this.tails.get(key) ?? EMPTY_ACTIVITY_TAIL,
        itemId,
        text,
      ),
    );
    this.markDirty();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  snapshot = () => {
    if (this.dirty) {
      this.published = Object.fromEntries(this.tails);
      this.dirty = false;
    }
    return this.published;
  };

  private markDirty() {
    this.dirty = true;
    if (this.notifyHandle !== null || this.listeners.size === 0) return;
    // Tokens arrive far faster than a screen refreshes. Coalescing to a frame
    // keeps a dozen streaming cards at one render per frame between them
    // rather than one render per token.
    const schedule =
      typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame
        : (callback: FrameRequestCallback) =>
            setTimeout(() => callback(0), 16) as unknown as number;
    this.notifyHandle = schedule(() => {
      this.notifyHandle = null;
      for (const listener of this.listeners) listener();
    });
  }
}

export const activityTailStore = new ActivityTailStore();

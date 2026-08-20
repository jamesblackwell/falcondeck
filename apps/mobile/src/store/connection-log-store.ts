/**
 * Connection log store.
 *
 * A bounded, timestamped trace of everything the app does to reach a usable
 * relay session: pairing, socket connects, key bootstrap, snapshot fetches,
 * retries, disconnects. The connection debug screen renders it live so launch
 * problems are visible instead of reading as a frozen app.
 *
 * This is diagnostic transparency, not a logger: entries are user-facing
 * strings, capped, and never persisted.
 */
import { create } from 'zustand'

export type ConnectionLogLevel = 'info' | 'success' | 'warn' | 'error'

export interface ConnectionLogEntry {
  id: number
  at: number
  level: ConnectionLogLevel
  message: string
  detail?: string
  /** Collapsed repeats keep a flaky link debuggable without drowning the log. */
  count?: number
}

const MAX_ENTRIES = 300
const REPEAT_WINDOW_MS = 5_000

let nextId = 1

interface ConnectionLogState {
  entries: ConnectionLogEntry[]
  /** Debug screen visibility, driven by auto-show logic plus manual opens. */
  visible: boolean
  /**
   * Set when the user closes the screen; suppresses auto-show until the next
   * app run so closing it once is a real dismissal, not a repeat popup.
   */
  dismissedForRun: boolean
}

interface ConnectionLogActions {
  _append: (entry: Omit<ConnectionLogEntry, 'id' | 'at'>) => void
  show: () => void
  hide: () => void
}

export const useConnectionLogStore = create<
  ConnectionLogState & ConnectionLogActions
>((set) => ({
  entries: [],
  visible: false,
  dismissedForRun: false,

  _append: (entry) =>
    set((state) => {
      const now = Date.now()
      const previous = state.entries[state.entries.length - 1]
      if (
        previous &&
        previous.level === entry.level &&
        previous.message === entry.message &&
        previous.detail === entry.detail &&
        now - previous.at <= REPEAT_WINDOW_MS
      ) {
        return {
          entries: [
            ...state.entries.slice(0, -1),
            { ...previous, at: now, count: (previous.count ?? 1) + 1 },
          ],
        }
      }
      return {
        entries: [...state.entries, { ...entry, id: nextId++, at: now }].slice(
          -MAX_ENTRIES,
        ),
      }
    }),

  show: () => set({ visible: true }),
  hide: () => set({ visible: false, dismissedForRun: true }),
}))

/** Log from anywhere — stores, hooks, callbacks — without a React binding. */
export function logConnection(
  level: ConnectionLogLevel,
  message: string,
  detail?: string,
): void {
  useConnectionLogStore.getState()._append({ level, message, detail })
}

/** Open the debug screen without clearing the run's dismissal flag. */
export function openConnectionDebug(): void {
  useConnectionLogStore.getState().show()
}

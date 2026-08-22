/**
 * Connection log store.
 *
 * A bounded, timestamped trace of everything the app does to reach a usable
 * relay session: pairing, socket connects, key bootstrap, snapshot fetches,
 * retries, disconnects. The connection debug screen renders it live so launch
 * problems are visible instead of reading as a frozen app.
 *
 * Named actions (`beginConnectionAction` / `endConnectionAction`) are the
 * timed spans. Point events stay on `logConnection`. Entries are user-facing
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
  /** Named span this row belongs to. Point events leave it unset. */
  action?: string
  /** Epoch ms when the action started. Unset for point events. */
  startedAt?: number
  /** Epoch ms when the action finished. Unset while in flight. */
  endedAt?: number
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
  _beginAction: (
    action: string,
    level: ConnectionLogLevel,
    message: string,
    detail?: string,
  ) => void
  _endAction: (action: string) => void
  _abandonActions: () => void
  show: () => void
  hide: () => void
}

function isInFlightEntry(entry: ConnectionLogEntry): boolean {
  return entry.startedAt != null && entry.endedAt == null
}

function findLastInFlightIndex(
  entries: ConnectionLogEntry[],
  action?: string,
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]
    if (!entry || !isInFlightEntry(entry)) continue
    if (action !== undefined && entry.action !== action) continue
    return index
  }
  return -1
}

function freezeEntry(
  entry: ConnectionLogEntry,
  endedAt: number,
): ConnectionLogEntry {
  if (!isInFlightEntry(entry) || entry.startedAt == null) return entry
  return {
    ...entry,
    endedAt: Math.max(endedAt, entry.startedAt),
  }
}

function capEntries(entries: ConnectionLogEntry[]): ConnectionLogEntry[] {
  return entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries
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
      // Spans are not repeats: coalescing into an in-flight row would hide
      // the live timer, and a completed span's duration is not a count.
      if (
        previous &&
        previous.startedAt == null &&
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
        entries: capEntries([
          ...state.entries,
          { ...entry, id: nextId++, at: now },
        ]),
      }
    }),

  _beginAction: (action, level, message, detail) =>
    set((state) => {
      if (!action) return state
      const now = Date.now()
      const inFlightIndex = findLastInFlightIndex(state.entries, action)
      const entries =
        inFlightIndex === -1
          ? state.entries
          : state.entries.map((entry, index) =>
              index === inFlightIndex ? freezeEntry(entry, now) : entry,
            )
      return {
        entries: capEntries([
          ...entries,
          {
            id: nextId++,
            at: now,
            level,
            message,
            detail,
            action,
            startedAt: now,
          },
        ]),
      }
    }),

  _endAction: (action) =>
    set((state) => {
      if (!action) return state
      const index = findLastInFlightIndex(state.entries, action)
      if (index === -1) return state
      const now = Date.now()
      return {
        entries: state.entries.map((entry, entryIndex) =>
          entryIndex === index ? freezeEntry(entry, now) : entry,
        ),
      }
    }),

  _abandonActions: () =>
    set((state) => {
      const now = Date.now()
      let changed = false
      const entries = state.entries.map((entry) => {
        if (!isInFlightEntry(entry)) return entry
        changed = true
        return freezeEntry(entry, now)
      })
      return changed ? { entries } : state
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

/**
 * Start a named timed action. The debug screen shows a live duration until
 * `endConnectionAction` or `abandonConnectionActions` freezes it.
 *
 * Starting the same action again freezes the previous row (a retry) rather
 * than leaking a second live timer.
 */
export function beginConnectionAction(
  action: string,
  level: ConnectionLogLevel,
  message: string,
  detail?: string,
): void {
  useConnectionLogStore.getState()._beginAction(action, level, message, detail)
}

/**
 * Freeze a named action's duration. No-op when that action is not in flight,
 * so a completion that races a reconnect cannot invent a timing.
 */
export function endConnectionAction(action: string): void {
  useConnectionLogStore.getState()._endAction(action)
}

/**
 * Freeze every in-flight action. Used when the connection run is torn down
 * so a dropped handshake does not tick forever.
 */
export function abandonConnectionActions(): void {
  useConnectionLogStore.getState()._abandonActions()
}

export function isConnectionActionInFlight(
  entry: ConnectionLogEntry,
): boolean {
  return isInFlightEntry(entry)
}

export function hasInFlightConnectionAction(action: string): boolean {
  if (!action) return false
  return (
    findLastInFlightIndex(useConnectionLogStore.getState().entries, action) !==
    -1
  )
}

/**
 * Elapsed ms for a timed action. In-flight rows use `now`; completed rows
 * use the stamped end. Clock rollback is clamped to zero. Point events
 * return null — the UI should not invent a duration.
 */
export function connectionActionDurationMs(
  entry: ConnectionLogEntry,
  now: number,
): number | null {
  if (entry.startedAt == null || !Number.isFinite(entry.startedAt)) return null
  const end =
    entry.endedAt != null && Number.isFinite(entry.endedAt)
      ? entry.endedAt
      : now
  if (!Number.isFinite(end)) return 0
  return Math.max(0, end - entry.startedAt)
}

/**
 * Friendly duration for the connection debug overlay.
 * Sub-second → milliseconds rounded to 10ms; 1–9.9s → one decimal;
 * 10–59s → whole seconds; longer → "1m 12s".
 */
export function formatConnectionDurationMs(ms: number): string {
  if (!Number.isFinite(ms)) return '0ms'
  const elapsed = Math.max(0, ms)
  if (elapsed < 1_000) {
    const rounded = Math.round(elapsed / 10) * 10
    if (rounded >= 1_000) return '1.0s'
    return `${rounded}ms`
  }
  if (elapsed < 10_000) {
    const tenths = Math.round(elapsed / 100) / 10
    if (tenths >= 10) return '10s'
    return `${tenths.toFixed(1)}s`
  }
  if (elapsed < 60_000) {
    return `${Math.round(elapsed / 1_000)}s`
  }
  const totalSeconds = Math.round(elapsed / 1_000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
}

/** Open the debug screen without clearing the run's dismissal flag. */
export function openConnectionDebug(): void {
  useConnectionLogStore.getState().show()
}

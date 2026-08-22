import { normalizeEventEnvelope, normalizeInteractiveRequest } from './normalization'
import type { EventEnvelope, MachinePresence } from './types'

/**
 * Removes exactly the updates visible at the start of a display-frame flush.
 * Updates appended while asynchronous decryption is running remain in the
 * source queue for the next scheduled frame instead of causing another state
 * commit inside the current paint interval.
 *
 * Capture itself takes the whole queue: session-bootstrap then splices parked
 * ciphertext into this same array. The time budget below is what actually
 * yields so a reconnect dump cannot occupy the JS thread for seconds.
 */
export function captureRelayDisplayFrame<T>(pending: T[]): T[] {
  return pending.splice(0, pending.length)
}

/** One paint frame. Long enough to decrypt a few small updates, short enough that a tap can land. */
export const RELAY_DISPLAY_FRAME_BUDGET_MS = 8

/**
 * Pause a reconnect dump so React Native can paint and handle presses.
 * Remaining updates stay queued; `remainingCount === 0` never yields, so a
 * single fat snapshot still completes in this turn (it already exceeded the
 * budget) rather than being postponed forever.
 */
export function shouldYieldRelayDisplayFrame(
  startedAtMs: number,
  nowMs: number,
  remainingCount: number,
  budgetMs = RELAY_DISPLAY_FRAME_BUDGET_MS,
) {
  return remainingCount > 0 && nowMs - startedAtMs >= budgetMs
}

/**
 * Put unprocessed updates back at the front of the live queue, ahead of
 * anything that arrived while this frame was decrypting.
 */
export function returnUnprocessedRelayUpdates<T>(pending: T[], unprocessed: T[]) {
  if (unprocessed.length === 0) return
  pending.unshift(...unprocessed)
}

/**
 * Hold MMKV/session persist until this process has no leftover replay.
 * The in-memory cursor already only advances for consumed updates, so a
 * crash still replays the rest. Persisting every 8ms frame would hitch on
 * stringify of the whole snapshot.
 */
export function shouldPersistRelayFlushCursor(pendingUpdateCount: number) {
  return pendingUpdateCount <= 0
}

/**
 * Live streaming is usually one update. A reconnect dump is many. Yielding
 * one paint before decrypting that dump lets cached nav handle a tap first.
 */
export function shouldYieldBeforeRelayDisplayFlush(batchLength: number) {
  return batchLength > 1
}

export function yieldRelayDisplayFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof globalThis.requestAnimationFrame === 'function') {
      globalThis.requestAnimationFrame(() => resolve())
      return
    }
    setTimeout(resolve, 0)
  })
}

/** Parallel decrypts per frame on web. Mobile decrypts one-by-one against the time budget. */
export const RELAY_DISPLAY_FRAME_MAX_ENCRYPTED = 8

/**
 * Presence is plaintext on the relay envelope. Read it before decrypting
 * replay so snapshot.current can be in flight and fat snapshot events skip
 * apply (they still have to decrypt — the envelope has no type).
 */
export function selectPresenceFromRelayBatch(
  batch: Array<{ seq: number; body: { t: string; presence?: MachinePresence } }>,
  floor: number | null,
): MachinePresence | undefined {
  let presence: MachinePresence | undefined
  for (const update of batch) {
    if (update.body.t !== 'presence' || !update.body.presence) continue
    if (floor === null || update.seq >= floor) {
      presence = update.body.presence
    }
  }
  return presence
}

/**
 * Durable full-snapshot events on the replay log are the recovery amplifier.
 * While snapshot.current is in flight the RPC is the base, so re-applying
 * those envelopes would hitch the JS thread and replace the slim RPC result.
 */
export function shouldIgnoreReplaySnapshotEvent(
  snapshotRequestInFlight: boolean,
  eventType: string,
) {
  return snapshotRequestInFlight && eventType === 'snapshot'
}

/**
 * A dedicated `daemon-event` snapshot publishes `type` before the huge
 * payload. Mixed `daemon-events` batches must still be parsed so non-snapshot
 * events are not dropped. Only inspect a prefix — the snapshot body can be
 * megabytes.
 */
export function encryptedPayloadIsSoleSnapshotEvent(plaintext: string) {
  if (!plaintext) return false
  const prefix = plaintext.length > 2048 ? plaintext.slice(0, 2048) : plaintext
  const hasSnapshotType =
    prefix.includes('"type":"snapshot"') || prefix.includes('"type": "snapshot"')
  if (!hasSnapshotType) return false
  if (
    prefix.includes('"kind":"daemon-events"') ||
    prefix.includes('"kind": "daemon-events"')
  ) {
    return false
  }
  return (
    prefix.includes('"kind":"daemon-event"') ||
    prefix.includes('"kind": "daemon-event"')
  )
}

/**
 * Reads both the original one-event envelope and the batched streaming form.
 * Keeping the old form accepted lets older daemons and clients reconnect
 * without a protocol migration.
 */
export function parseDaemonEvents(payload: unknown): EventEnvelope[] {
  if (!payload || typeof payload !== 'object') return []

  const record = payload as Record<string, unknown>
  if (record.kind === 'daemon-event' && record.event && typeof record.event === 'object') {
    const normalized = normalizeRemoteEvent(record.event as Record<string, unknown>)
    return normalized ? [normalized] : []
  }
  if (record.kind !== 'daemon-events' || !Array.isArray(record.events)) return []

  const events: EventEnvelope[] = []
  for (const event of record.events) {
    if (!event || typeof event !== 'object') continue
    const normalized = normalizeRemoteEvent(event as Record<string, unknown>)
    if (normalized) events.push(normalized)
  }
  return events
}

function normalizeRemoteEvent(value: Record<string, unknown>): EventEnvelope | null {
  if (
    typeof value.seq !== 'number' ||
    !Number.isFinite(value.seq) ||
    typeof value.emitted_at !== 'string' ||
    !value.event ||
    typeof value.event !== 'object'
  ) {
    return null
  }
  const normalized = normalizeEventEnvelope(value)
  if (normalized.event.type !== 'interactive-request') return normalized
  const request = normalizeInteractiveRequest(normalized.event.request)
  return request ? { ...normalized, event: { ...normalized.event, request } } : null
}

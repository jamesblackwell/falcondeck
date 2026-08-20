import { normalizeEventEnvelope, normalizeInteractiveRequest } from './normalization'
import type { EventEnvelope } from './types'

/**
 * Removes exactly the updates visible at the start of a display-frame flush.
 * Updates appended while asynchronous decryption is running remain in the
 * source queue for the next scheduled frame instead of causing another state
 * commit inside the current paint interval.
 */
export function captureRelayDisplayFrame<T>(pending: T[]): T[] {
  return pending.splice(0, pending.length)
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

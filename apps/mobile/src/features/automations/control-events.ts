import type { ControlStateChanged, EventEnvelope } from '@falcondeck/client-core'

type Listener = (change: ControlStateChanged) => void
const listeners = new Set<Listener>()

export function subscribeToControlStateChanges(listener: Listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Bridges the unified relay event stream to feature-local invalidation
 * without making the conversation store subscribe to automation data. */
export function publishControlStateChanges(events: readonly EventEnvelope[]) {
  for (const envelope of events) {
    if (envelope.event.type !== 'control-state-changed') continue
    for (const listener of listeners) listener(envelope.event.change)
  }
}

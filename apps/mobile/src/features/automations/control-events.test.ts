import { describe, expect, it, vi } from 'vitest'

import type { EventEnvelope } from '@falcondeck/client-core'

import { publishControlStateChanges, subscribeToControlStateChanges } from './control-events'

describe('automation control event bridge', () => {
  it('publishes only control state changes and unsubscribes cleanly', () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToControlStateChanges(listener)
    publishControlStateChanges([
      {
        seq: 1,
        emitted_at: '2026-08-23T12:00:00Z',
        workspace_id: null,
        thread_id: null,
        event: {
          type: 'control-state-changed',
          change: { store_revision: 9, domains: ['automations'] },
        },
      },
      {
        seq: 2,
        emitted_at: '2026-08-23T12:00:01Z',
        workspace_id: null,
        thread_id: null,
        event: { type: 'text', text: 'ignored' },
      },
    ] as EventEnvelope[])

    expect(listener).toHaveBeenCalledOnce()
    expect(listener).toHaveBeenCalledWith({ store_revision: 9, domains: ['automations'] })
    unsubscribe()
    publishControlStateChanges([])
    expect(listener).toHaveBeenCalledOnce()
  })
})

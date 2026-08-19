import { describe, it, expect, beforeEach } from 'vitest'

import { logConnection, openConnectionDebug, useConnectionLogStore } from './connection-log-store'

describe('connection-log-store', () => {
  beforeEach(() => {
    useConnectionLogStore.setState({ entries: [], visible: false, dismissedForRun: false })
  })

  it('appends timestamped entries from anywhere', () => {
    logConnection('info', 'Relay: connecting')
    logConnection('error', 'Error', 'socket closed')

    const entries = useConnectionLogStore.getState().entries
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ level: 'info', message: 'Relay: connecting' })
    expect(entries[0].at).toBeGreaterThan(0)
    expect(entries[1]).toMatchObject({ level: 'error', message: 'Error', detail: 'socket closed' })
  })

  it('caps the buffer, keeping the newest entries', () => {
    for (let i = 0; i < 400; i++) {
      logConnection('info', `entry ${i}`)
    }
    const entries = useConnectionLogStore.getState().entries
    expect(entries).toHaveLength(300)
    expect(entries[0].message).toBe('entry 100')
    expect(entries[299].message).toBe('entry 399')
  })

  it('hide dismisses auto-show for the run; openConnectionDebug reopens without clearing the dismissal', () => {
    useConnectionLogStore.getState().hide()
    expect(useConnectionLogStore.getState().dismissedForRun).toBe(true)
    expect(useConnectionLogStore.getState().visible).toBe(false)

    openConnectionDebug()
    expect(useConnectionLogStore.getState().visible).toBe(true)
    // Still dismissed: a later busy period must not auto-show again.
    expect(useConnectionLogStore.getState().dismissedForRun).toBe(true)
  })
})

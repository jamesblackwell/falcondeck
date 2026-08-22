import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  abandonConnectionActions,
  beginConnectionAction,
  connectionActionDurationMs,
  endConnectionAction,
  formatConnectionDurationMs,
  hasInFlightConnectionAction,
  isConnectionActionInFlight,
  logConnection,
  openConnectionDebug,
  useConnectionLogStore,
} from './connection-log-store'

describe('connection-log-store', () => {
  beforeEach(() => {
    useConnectionLogStore.setState({
      entries: [],
      visible: false,
      dismissedForRun: false,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('appends timestamped entries from anywhere', () => {
    logConnection('info', 'Relay: connecting')
    logConnection('error', 'Error', 'socket closed')

    const entries = useConnectionLogStore.getState().entries
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      level: 'info',
      message: 'Relay: connecting',
    })
    expect(entries[0].at).toBeGreaterThan(0)
    expect(entries[1]).toMatchObject({
      level: 'error',
      message: 'Error',
      detail: 'socket closed',
    })
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

  it('coalesces repeated connection failures into one diagnostic entry', () => {
    logConnection(
      'warn',
      'Desktop is connected, but that action is not ready yet.',
    )
    logConnection(
      'warn',
      'Desktop is connected, but that action is not ready yet.',
    )
    logConnection(
      'warn',
      'Desktop is connected, but that action is not ready yet.',
    )

    const entries = useConnectionLogStore.getState().entries
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      level: 'warn',
      message: 'Desktop is connected, but that action is not ready yet.',
      count: 3,
    })
  })

  it('does not coalesce a point event into an in-flight action', () => {
    beginConnectionAction('socket', 'info', 'Relay: connecting')
    logConnection('info', 'Relay: connecting')

    const entries = useConnectionLogStore.getState().entries
    expect(entries).toHaveLength(2)
    expect(isConnectionActionInFlight(entries[0]!)).toBe(true)
    expect(entries[1]!.message).toBe('Relay: connecting')
    expect(isConnectionActionInFlight(entries[1]!)).toBe(false)
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

  describe('timed actions', () => {
    it('records duration when an action completes', () => {
      vi.useFakeTimers()
      vi.setSystemTime(1_000)

      beginConnectionAction('socket', 'info', 'Relay: connecting')
      vi.setSystemTime(1_180)
      endConnectionAction('socket')

      const entry = useConnectionLogStore.getState().entries[0]!
      expect(isConnectionActionInFlight(entry)).toBe(false)
      expect(connectionActionDurationMs(entry, 1_180)).toBe(180)
      expect(entry.message).toBe('Relay: connecting')
      expect(entry.at).toBe(1_000)
    })

    it('keeps in-flight rows live until they are ended', () => {
      vi.useFakeTimers()
      vi.setSystemTime(5_000)

      beginConnectionAction(
        'snapshot',
        'info',
        'Fetching project list (attempt 1)',
      )
      const live = useConnectionLogStore.getState().entries[0]!
      expect(isConnectionActionInFlight(live)).toBe(true)
      expect(connectionActionDurationMs(live, 5_400)).toBe(400)

      vi.setSystemTime(10_000)
      endConnectionAction('snapshot')
      logConnection('success', 'Projects synced.')

      const entries = useConnectionLogStore.getState().entries
      expect(connectionActionDurationMs(entries[0]!, 10_000)).toBe(5_000)
      expect(isConnectionActionInFlight(entries[0]!)).toBe(false)
      expect(entries[1]).toMatchObject({ message: 'Projects synced.' })
    })

    it('restarts the same action without leaking a live timer', () => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      beginConnectionAction('snapshot', 'info', 'Fetching project list (attempt 1)')
      vi.setSystemTime(1_200)
      beginConnectionAction('snapshot', 'info', 'Fetching project list (attempt 2)')

      const entries = useConnectionLogStore.getState().entries
      expect(entries).toHaveLength(2)
      expect(isConnectionActionInFlight(entries[0]!)).toBe(false)
      expect(connectionActionDurationMs(entries[0]!, 1_200)).toBe(1_200)
      expect(isConnectionActionInFlight(entries[1]!)).toBe(true)
      expect(entries[1]!.message).toBe('Fetching project list (attempt 2)')
    })

    it('ignores end when that action was never started', () => {
      logConnection('info', 'Relay socket connected.')
      endConnectionAction('socket')
      expect(useConnectionLogStore.getState().entries).toHaveLength(1)
      expect(useConnectionLogStore.getState().entries[0]!.endedAt).toBeUndefined()
    })

    it('reports whether a named action is still in flight', () => {
      expect(hasInFlightConnectionAction('socket')).toBe(false)
      beginConnectionAction('socket', 'info', 'Relay: connecting')
      expect(hasInFlightConnectionAction('socket')).toBe(true)
      expect(hasInFlightConnectionAction('snapshot')).toBe(false)
      endConnectionAction('socket')
      expect(hasInFlightConnectionAction('socket')).toBe(false)
    })

    it('ignores empty action names rather than colliding on ""', () => {
      beginConnectionAction('', 'info', 'should not span')
      const entries = useConnectionLogStore.getState().entries
      expect(entries).toHaveLength(0)
      endConnectionAction('')
      expect(useConnectionLogStore.getState().entries).toHaveLength(0)
    })

    it('abandons every in-flight action so reconnects do not tick forever', () => {
      vi.useFakeTimers()
      vi.setSystemTime(0)
      beginConnectionAction('socket', 'info', 'Relay: connecting')
      beginConnectionAction('snapshot', 'info', 'Fetching project list (attempt 1)')
      vi.setSystemTime(2_500)
      abandonConnectionActions()

      const entries = useConnectionLogStore.getState().entries
      expect(entries.every((entry) => !isConnectionActionInFlight(entry))).toBe(
        true,
      )
      expect(connectionActionDurationMs(entries[0]!, 2_500)).toBe(2_500)
      expect(connectionActionDurationMs(entries[1]!, 2_500)).toBe(2_500)
    })

    it('clamps clock rollback to a zero duration', () => {
      vi.useFakeTimers()
      vi.setSystemTime(5_000)
      beginConnectionAction('socket', 'info', 'Relay: connecting')
      const live = useConnectionLogStore.getState().entries[0]!
      expect(connectionActionDurationMs(live, 4_000)).toBe(0)

      vi.setSystemTime(4_000)
      endConnectionAction('socket')
      const ended = useConnectionLogStore.getState().entries[0]!
      expect(ended.endedAt).toBe(5_000)
      expect(connectionActionDurationMs(ended, 4_000)).toBe(0)
    })

    it('does not invent a duration for point events', () => {
      logConnection('success', 'Desktop is connected to the relay.')
      const entry = useConnectionLogStore.getState().entries[0]!
      expect(connectionActionDurationMs(entry, Date.now())).toBeNull()
    })
  })
})

describe('formatConnectionDurationMs', () => {
  it('rounds sub-second values to 10ms', () => {
    expect(formatConnectionDurationMs(0)).toBe('0ms')
    expect(formatConnectionDurationMs(4)).toBe('0ms')
    expect(formatConnectionDurationMs(5)).toBe('10ms')
    expect(formatConnectionDurationMs(180)).toBe('180ms')
    expect(formatConnectionDurationMs(994)).toBe('990ms')
    expect(formatConnectionDurationMs(995)).toBe('1.0s')
  })

  it('uses one decimal between 1s and 10s, then whole seconds', () => {
    expect(formatConnectionDurationMs(1_000)).toBe('1.0s')
    expect(formatConnectionDurationMs(1_240)).toBe('1.2s')
    expect(formatConnectionDurationMs(5_000)).toBe('5.0s')
    expect(formatConnectionDurationMs(9_940)).toBe('9.9s')
    expect(formatConnectionDurationMs(9_950)).toBe('10s')
    expect(formatConnectionDurationMs(12_400)).toBe('12s')
  })

  it('formats a minute and longer in m/s', () => {
    expect(formatConnectionDurationMs(60_000)).toBe('1m')
    expect(formatConnectionDurationMs(61_200)).toBe('1m 1s')
    expect(formatConnectionDurationMs(73_000)).toBe('1m 13s')
  })

  it('treats non-finite and negative values as zero', () => {
    expect(formatConnectionDurationMs(Number.NaN)).toBe('0ms')
    expect(formatConnectionDurationMs(Number.POSITIVE_INFINITY)).toBe('0ms')
    expect(formatConnectionDurationMs(-40)).toBe('0ms')
  })
})

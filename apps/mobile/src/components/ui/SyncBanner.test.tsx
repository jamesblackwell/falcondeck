import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { resolveSessionSyncStatus } from '@/lib/session-status'
import { cleanup, renderComponent, textOf } from '../../test/render'
import { SyncBanner } from './SyncBanner'

afterEach(cleanup)

const base = {
  connectionStatus: 'encrypted',
  isEncrypted: true,
  isSyncing: false,
  hasSnapshot: true,
  daemonConnected: true,
  daemonRpcReady: true,
  hasSyncedOnce: true,
}

describe('SyncBanner', () => {
  it('renders nothing once the session is usable', () => {
    const r = renderComponent(<SyncBanner status={resolveSessionSyncStatus(base)} />)
    expect(r.toJSON()).toBeNull()
  })

  it('only names what the app is waiting for when the first sync takes seven seconds', () => {
    vi.useFakeTimers()
    try {
      const r = renderComponent(
        <SyncBanner status={resolveSessionSyncStatus({ ...base, hasSyncedOnce: false })} />,
      )

      expect(r.toJSON()).toBeNull()
      act(() => {
        vi.advanceTimersByTime(6_999)
      })
      expect(r.toJSON()).toBeNull()

      act(() => {
        vi.advanceTimersByTime(1)
      })
      const text = textOf(r)
      expect(text).toContain('Syncing your projects…')
      expect(text).toContain('out of date')
      cleanup()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rides out a short reconnect in silence, then names it', () => {
    vi.useFakeTimers()
    try {
      const connecting = resolveSessionSyncStatus({
        ...base,
        connectionStatus: 'connecting',
        isEncrypted: false,
      })
      const r = renderComponent(<SyncBanner status={connecting} />)

      expect(r.toJSON()).toBeNull()
      act(() => {
        vi.advanceTimersByTime(5_999)
      })
      expect(r.toJSON()).toBeNull()

      act(() => {
        vi.advanceTimersByTime(1)
      })
      const text = textOf(r)
      expect(text).toContain('Reconnecting…')
      expect(text).not.toContain('your Mac')
      cleanup()
    } finally {
      vi.useRealTimers()
    }
  })

  it('rides out an offline flap in silence, then names it', () => {
    vi.useFakeTimers()
    try {
      const offline = resolveSessionSyncStatus({
        ...base,
        daemonConnected: false,
      })
      const r = renderComponent(<SyncBanner status={offline} />)

      // The relay reports the Mac offline for a few seconds whenever its
      // stale daemon socket is discovered mid-reconnect; stay quiet until
      // the outage outlives a routine flap.
      expect(r.toJSON()).toBeNull()
      act(() => {
        vi.advanceTimersByTime(5_999)
      })
      expect(r.toJSON()).toBeNull()

      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(textOf(r)).toContain('Your Mac is offline')
      cleanup()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps one clock across connecting and securing so a stall still surfaces', () => {
    vi.useFakeTimers()
    try {
      const r = renderComponent(
        <SyncBanner
          status={resolveSessionSyncStatus({
            ...base,
            connectionStatus: 'connecting',
            isEncrypted: false,
          })}
        />,
      )
      act(() => {
        vi.advanceTimersByTime(4_000)
      })

      act(() => {
        r.update(
          <SyncBanner
            status={resolveSessionSyncStatus({
              ...base,
              connectionStatus: 'connected',
              isEncrypted: false,
            })}
          />,
        )
      })
      expect(r.toJSON()).toBeNull()

      act(() => {
        vi.advanceTimersByTime(2_000)
      })
      expect(textOf(r)).toContain('Securing session…')
      cleanup()
    } finally {
      vi.useRealTimers()
    }
  })

  it('announces itself politely to VoiceOver', () => {
    const now = Date.now()
    const r = renderComponent(
      <SyncBanner
        status={resolveSessionSyncStatus({
          ...base,
          hasSyncedOnce: false,
          syncStartedAt: now - 7_000,
        })}
      />,
    )
    const banner = r.root.findAll(
      (node) => node.props?.accessibilityRole === 'progressbar',
    )[0]
    expect(banner.props.accessibilityLiveRegion).toBe('polite')
    expect(banner.props.accessibilityLabel).toContain('Syncing your projects…')
  })

  it('shows attempts, retry timing, and the exact failure after a prolonged sync', () => {
    const now = Date.now()
    const r = renderComponent(
      <SyncBanner
        status={resolveSessionSyncStatus({
          ...base,
          hasSyncedOnce: false,
          syncStartedAt: now - 31_000,
          syncAttempt: 4,
          nextRetryAt: now + 3_000,
          lastError:
            'Your Mac is connected, but snapshot.current is not registered. FalconDeck will retry automatically.',
        })}
      />,
    )
    const text = textOf(r)
    expect(text).toContain('Waiting 31s · attempt 4 · retry in 3s')
    expect(text).toContain('Last error: Your Mac is connected')
    expect(text).toContain('snapshot.current is not registered')
    const banner = r.root.find(
      (node) => node.props?.accessibilityRole === 'progressbar',
    )
    expect(banner.props.accessibilityLabel).toContain('Waiting 31s · attempt 4')
    expect(banner.props.accessibilityLabel).toContain('Last error: Your Mac is connected')
  })
})

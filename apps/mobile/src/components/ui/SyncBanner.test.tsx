import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it } from 'vitest'

import { resolveSessionSyncStatus } from '@/lib/session-status'
import { cleanup, renderComponent, textOf } from '../../test/render'
import { SyncBanner } from './SyncBanner'

afterEach(cleanup)

const base = {
  connectionStatus: 'encrypted',
  isEncrypted: true,
  isSyncing: false,
  daemonConnected: true,
  daemonRpcReady: true,
  hasSyncedOnce: true,
}

describe('SyncBanner', () => {
  it('renders nothing once the session is usable', () => {
    const r = renderComponent(
      <SyncBanner status={resolveSessionSyncStatus(base)} />,
    )
    expect(r.toJSON()).toBeNull()
  })

  it('immediately names the first project sync', () => {
    const r = renderComponent(
      <SyncBanner
        status={resolveSessionSyncStatus({ ...base, hasSyncedOnce: false })}
      />,
    )

    const text = textOf(r)
    expect(text).toContain('Syncing your projects…')
    expect(text).not.toContain('out of date')
  })

  it('immediately names a relay reconnect', () => {
    const connecting = resolveSessionSyncStatus({
      ...base,
      connectionStatus: 'connecting',
      isEncrypted: false,
    })
    const r = renderComponent(<SyncBanner status={connecting} />)

    const text = textOf(r)
    expect(text).toContain('Reconnecting to relay…')
    expect(text).not.toContain('your Mac')
    expect(text).not.toContain('Mac')
  })

  it('immediately names an offline desktop', () => {
    const offline = resolveSessionSyncStatus({
      ...base,
      daemonConnected: false,
    })
    const r = renderComponent(<SyncBanner status={offline} />)

    expect(textOf(r)).toContain('Waiting for desktop…')
  })

  it('updates immediately as the connection moves from relay to encryption', () => {
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

    expect(textOf(r)).toContain('Securing session…')
  })

  it('updates immediately as recovery moves into RPC repair', () => {
    const r = renderComponent(
      <SyncBanner
        status={resolveSessionSyncStatus({ ...base, daemonConnected: false })}
      />,
    )

    act(() => {
      r.update(
        <SyncBanner
          status={resolveSessionSyncStatus({ ...base, daemonRpcReady: false })}
        />,
      )
    })

    expect(textOf(r)).toContain('Repairing sync…')
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
            'Desktop is connected, but sync is not ready yet. FalconDeck will retry automatically.',
        })}
      />,
    )
    const text = textOf(r)
    expect(text).toContain('Waiting 31s · attempt 4 · retry in 3s')
    expect(text).toContain(
      'Last error: Desktop is connected, but sync is not ready yet',
    )
    const banner = r.root.find(
      (node) => node.props?.accessibilityRole === 'progressbar',
    )
    expect(banner.props.accessibilityLabel).toContain('Waiting 31s · attempt 4')
    expect(banner.props.accessibilityLabel).toContain(
      'Last error: Desktop is connected, but sync is not ready yet',
    )
  })
})

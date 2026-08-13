import React from 'react'
import { afterEach, describe, expect, it } from 'vitest'

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

  it('names what the app is waiting for during the first sync', () => {
    const r = renderComponent(
      <SyncBanner status={resolveSessionSyncStatus({ ...base, hasSyncedOnce: false })} />,
    )
    const text = textOf(r)
    expect(text).toContain('Syncing your projects…')
    expect(text).toContain('out of date')
  })

  it('announces itself politely to VoiceOver', () => {
    const r = renderComponent(
      <SyncBanner status={resolveSessionSyncStatus({ ...base, hasSyncedOnce: false })} />,
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
  })
})

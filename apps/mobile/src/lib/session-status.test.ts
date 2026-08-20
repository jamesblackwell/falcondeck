import { describe, expect, it } from 'vitest'

import {
  resolveSessionSyncStatus,
  sessionSendBlockReason,
  shouldAutoShowConnectionDebug,
} from './session-status'

const ready = {
  connectionStatus: 'encrypted',
  isEncrypted: true,
  isSyncing: false,
  hasSnapshot: true,
  daemonConnected: true,
  daemonPresenceKnown: true,
  daemonRpcReady: true,
  hasSyncedOnce: true,
}

describe('resolveSessionSyncStatus', () => {
  it('is idle once the session is secured, synced and the desktop is up', () => {
    const status = resolveSessionSyncStatus(ready)
    expect(status.stage).toBe('ready')
    expect(status.isBusy).toBe(false)
  })

  it('reports the key exchange while the socket is up but unencrypted', () => {
    const status = resolveSessionSyncStatus({
      ...ready,
      connectionStatus: 'connected',
      isEncrypted: false,
    })
    expect(status.stage).toBe('securing')
    expect(status.isBusy).toBe(true)
  })

  it('reports reconnecting while the socket is down', () => {
    for (const connectionStatus of ['connecting', 'disconnected']) {
      const status = resolveSessionSyncStatus({
        ...ready,
        connectionStatus,
        isEncrypted: false,
      })
      expect(status.stage).toBe('connecting')
      // The phone's socket is to the relay, not the desktop — so the headline
      // does not blame a computer that may well be online.
      expect(status.label).toBe('Reconnecting to relay…')
      expect(sessionSendBlockReason(status)).toBe('Reconnecting to relay…')
    }
  })

  it('mentions the stale cache when reconnecting over cached projects', () => {
    const status = resolveSessionSyncStatus({
      ...ready,
      connectionStatus: 'connecting',
      isEncrypted: false,
    })
    expect(status.detail).toContain('last synced')
  })

  it('stays busy until the first snapshot lands, even with a cached one on screen', () => {
    const status = resolveSessionSyncStatus({ ...ready, hasSyncedOnce: false })
    expect(status.stage).toBe('syncing')
    expect(status.detail).toContain('out of date')
  })

  it('leaves the second line empty when it would only restate the headline', () => {
    const firstLoad = resolveSessionSyncStatus({
      ...ready,
      hasSnapshot: false,
      hasSyncedOnce: false,
    })
    expect(firstLoad.label).toBe('Syncing your projects…')
    expect(firstLoad.detail).toBe('')

    const securing = resolveSessionSyncStatus({
      ...ready,
      connectionStatus: 'connected',
      isEncrypted: false,
    })
    expect(securing.detail).toBe('')
  })

  it('keeps a second line only where the user has something to do', () => {
    const offline = resolveSessionSyncStatus({
      ...ready,
      daemonConnected: false,
    })
    expect(offline.label).toBe('Waiting for desktop…')
    expect(offline.detail).toContain('Keep FalconDeck open')
  })

  it('reports syncing again on a later refetch', () => {
    expect(resolveSessionSyncStatus({ ...ready, isSyncing: true }).stage).toBe(
      'syncing',
    )
  })

  it('distinguishes a live desktop whose snapshot RPC registration is missing', () => {
    const status = resolveSessionSyncStatus({
      ...ready,
      hasSyncedOnce: false,
      daemonRpcReady: false,
    })
    expect(status.stage).toBe('repairing')
    expect(status.detail).toContain('not ready to sync yet')
    expect(sessionSendBlockReason(status)).toBe('Repairing sync…')
  })

  it('keeps reporting a missing snapshot RPC after a previous successful sync', () => {
    const status = resolveSessionSyncStatus({
      ...ready,
      daemonRpcReady: false,
    })
    expect(status.stage).toBe('repairing')
    expect(sessionSendBlockReason(status)).toBe('Repairing sync…')
  })

  it('reports an offline desktop instead of a generic first-sync wait', () => {
    const status = resolveSessionSyncStatus({
      ...ready,
      daemonConnected: false,
      hasSyncedOnce: false,
      isSyncing: true,
    })
    expect(status.stage).toBe('offline')
  })

  it('waits for the first presence frame instead of flashing an offline error', () => {
    const status = resolveSessionSyncStatus({
      ...ready,
      daemonConnected: false,
      daemonPresenceKnown: false,
    })
    expect(status.stage).toBe('syncing')
    expect(status.label).toBe('Checking desktop…')
  })

  it('surfaces an offline desktop once the session itself is healthy', () => {
    const status = resolveSessionSyncStatus({
      ...ready,
      daemonConnected: false,
    })
    expect(status.stage).toBe('offline')
    expect(status.isBusy).toBe(true)
  })

  it('reports pairing ahead of everything else', () => {
    const status = resolveSessionSyncStatus({
      ...ready,
      connectionStatus: 'claiming',
      isEncrypted: false,
    })
    expect(status.stage).toBe('pairing')
  })

  it('treats an unpaired app as offline rather than connecting', () => {
    const status = resolveSessionSyncStatus({
      ...ready,
      connectionStatus: 'not_connected',
      isEncrypted: false,
    })
    expect(status.stage).toBe('offline')
  })
})

describe('sessionSendBlockReason', () => {
  it('has no reason when the session is ready', () => {
    expect(sessionSendBlockReason(resolveSessionSyncStatus(ready))).toBeNull()
  })

  it('explains the wait instead of a bare "reconnect"', () => {
    const reason = sessionSendBlockReason(
      resolveSessionSyncStatus({
        ...ready,
        connectionStatus: 'connected',
        isEncrypted: false,
      }),
    )
    expect(reason).toBe('Securing session…')
  })

  it('uses the same offline headline for send as for the banner', () => {
    expect(
      sessionSendBlockReason(
        resolveSessionSyncStatus({ ...ready, daemonConnected: false }),
      ),
    ).toBe('Waiting for desktop…')
  })
})

describe('shouldAutoShowConnectionDebug', () => {
  it('uses the delayed connection screen for every prolonged wait', () => {
    expect(
      shouldAutoShowConnectionDebug(
        resolveSessionSyncStatus({
          ...ready,
          connectionStatus: 'connecting',
          isEncrypted: false,
        }),
      ),
    ).toBe(true)
    expect(
      shouldAutoShowConnectionDebug(
        resolveSessionSyncStatus({ ...ready, daemonConnected: false }),
      ),
    ).toBe(true)
  })

  it('includes a stuck handshake and first sync, but never a ready session', () => {
    expect(
      shouldAutoShowConnectionDebug(
        resolveSessionSyncStatus({
          ...ready,
          connectionStatus: 'connected',
          isEncrypted: false,
        }),
      ),
    ).toBe(true)
    expect(
      shouldAutoShowConnectionDebug(
        resolveSessionSyncStatus({ ...ready, hasSyncedOnce: false }),
      ),
    ).toBe(true)
    expect(shouldAutoShowConnectionDebug(resolveSessionSyncStatus(ready))).toBe(
      false,
    )
  })
})

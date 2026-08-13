import { describe, expect, it } from 'vitest'

import { resolveSessionSyncStatus, sessionSendBlockReason } from './session-status'

const ready = {
  connectionStatus: 'encrypted',
  isEncrypted: true,
  isSyncing: false,
  hasSnapshot: true,
  daemonConnected: true,
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
      const status = resolveSessionSyncStatus({ ...ready, connectionStatus, isEncrypted: false })
      expect(status.stage).toBe('connecting')
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

  it('reports syncing again on a later refetch', () => {
    expect(resolveSessionSyncStatus({ ...ready, isSyncing: true }).stage).toBe('syncing')
  })

  it('distinguishes a live Mac whose snapshot RPC registration is missing', () => {
    const status = resolveSessionSyncStatus({
      ...ready,
      hasSyncedOnce: false,
      daemonRpcReady: false,
    })
    expect(status.stage).toBe('repairing')
    expect(status.detail).toContain('sync service is re-registering')
    expect(sessionSendBlockReason(status)).toBe('Repairing sync with your Mac…')
  })

  it('surfaces an offline desktop once the session itself is healthy', () => {
    const status = resolveSessionSyncStatus({ ...ready, daemonConnected: false })
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
      resolveSessionSyncStatus({ ...ready, connectionStatus: 'connected', isEncrypted: false }),
    )
    expect(reason).toBe('Securing session…')
  })
})

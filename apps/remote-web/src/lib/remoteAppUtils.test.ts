import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  generateBoxKeyPair,
  REMOTE_SESSION_STORAGE_VERSION,
  secretKeyToBase64,
  type ConversationItem,
  type DaemonSnapshot,
} from '@falcondeck/client-core'

import {
  AwaitedActionTimeoutError,
  boundRetainedThreadItems,
  canPostNotifications,
  canWarmStartFromSnapshotCache,
  clearPersistedRemoteSession,
  clearPersistedRemoteSnapshot,
  clearPendingActionIds,
  clearPairingParamsFromUrl,
  connectionBadgeState,
  createSnapshotCacheScheduler,
  deriveConnectionHelpState,
  deviceLabelForUserAgent,
  forgetPendingActionAfterError,
  loadPendingActionIds,
  loadPersistedRemoteSnapshot,
  loadNotificationPreference,
  loadOrCreateClientKeyPair,
  loadPersistedRemoteSession,
  loadPersistedSelection,
  MAX_PERSISTED_PENDING_ACTIONS,
  persistPendingActionIds,
  persistNotificationPreference,
  persistRemoteSession,
  persistRemoteSnapshot,
  persistSelection,
  postThreadNotification,
  resumePendingActions,
  resolveRestoredSelection,
  scheduleVisibilityAwareFlush,
  shouldApplyReplayPresence,
  snapshotRetryDelayMs,
  urlWithoutPairingParams,
} from './remoteAppUtils'

afterEach(() => {
  window.localStorage.clear()
  window.sessionStorage.clear()
})

describe('remote session secret persistence', () => {
  it('keeps cryptographic keys out of durable localStorage', () => {
    const clientSecretKey = secretKeyToBase64(generateBoxKeyPair())
    const dataKey = 'data-key-material'
    persistRemoteSession({
      version: REMOTE_SESSION_STORAGE_VERSION,
      relayUrl: 'https://connect.example.com',
      pairingCode: 'PAIR-CODE',
      sessionId: 'session-1',
      clientToken: 'client-token',
      clientSecretKey,
      dataKey,
    })

    const durable = window.localStorage.getItem('falcondeck.remote.session.v1:session-1') ?? ''
    expect(durable).not.toBe('')
    expect(durable).not.toContain(clientSecretKey)
    expect(durable).not.toContain(dataKey)
    expect(durable).not.toContain('PAIR-CODE')
    expect(loadPersistedRemoteSession()).toMatchObject({
      clientSecretKey,
      dataKey,
    })
  })

  it('does not resume durable metadata after tab secrets are gone', () => {
    persistRemoteSession({
      version: REMOTE_SESSION_STORAGE_VERSION,
      relayUrl: 'https://connect.example.com',
      pairingCode: '',
      sessionId: 'session-1',
      clientToken: 'client-token',
      clientSecretKey: secretKeyToBase64(generateBoxKeyPair()),
    })
    window.sessionStorage.clear()

    expect(loadPersistedRemoteSession()).toBeNull()
    expect(window.localStorage.getItem('falcondeck.remote.session.v1:session-1')).not.toBeNull()
  })

  it('uses the metadata matching this tab instead of another tab session', () => {
    persistRemoteSession({
      version: REMOTE_SESSION_STORAGE_VERSION,
      relayUrl: 'https://connect.example.com',
      pairingCode: '',
      sessionId: 'session-1',
      clientToken: 'client-token-1',
      clientSecretKey: secretKeyToBase64(generateBoxKeyPair()),
    })
    const staleSecrets = window.sessionStorage.getItem('falcondeck.remote.session-secrets.v1')

    persistRemoteSession({
      version: REMOTE_SESSION_STORAGE_VERSION,
      relayUrl: 'https://connect.example.com',
      pairingCode: '',
      sessionId: 'session-2',
      clientToken: 'client-token-2',
      clientSecretKey: secretKeyToBase64(generateBoxKeyPair()),
    })
    window.sessionStorage.setItem('falcondeck.remote.session-secrets.v1', staleSecrets!)

    expect(loadPersistedRemoteSession()).toMatchObject({
      sessionId: 'session-1',
      clientToken: 'client-token-1',
    })
    expect(window.localStorage.getItem('falcondeck.remote.session.v1:session-2')).toContain('session-2')
  })

  it('discards corrupt tab secrets without erasing shared durable metadata', () => {
    persistRemoteSession({
      version: REMOTE_SESSION_STORAGE_VERSION,
      relayUrl: 'https://connect.example.com',
      pairingCode: '',
      sessionId: 'session-1',
      clientToken: 'client-token',
      clientSecretKey: secretKeyToBase64(generateBoxKeyPair()),
    })
    window.sessionStorage.setItem('falcondeck.remote.session-secrets.v1', '{not-json')

    expect(loadPersistedRemoteSession()).toBeNull()
    expect(window.sessionStorage.getItem('falcondeck.remote.session-secrets.v1')).toBeNull()
    expect(window.localStorage.getItem('falcondeck.remote.session.v1:session-1')).toContain('session-1')
  })

  it('lets two tabs resume different sessions without overwriting each other', () => {
    persistRemoteSession({
      version: REMOTE_SESSION_STORAGE_VERSION,
      relayUrl: 'https://connect.example.com',
      pairingCode: '',
      sessionId: 'session-1',
      clientToken: 'client-token-1',
      clientSecretKey: secretKeyToBase64(generateBoxKeyPair()),
    })
    const firstTabSecrets = window.sessionStorage.getItem('falcondeck.remote.session-secrets.v1')

    persistRemoteSession({
      version: REMOTE_SESSION_STORAGE_VERSION,
      relayUrl: 'https://connect.example.com',
      pairingCode: '',
      sessionId: 'session-2',
      clientToken: 'client-token-2',
      clientSecretKey: secretKeyToBase64(generateBoxKeyPair()),
    })
    const secondTabSecrets = window.sessionStorage.getItem('falcondeck.remote.session-secrets.v1')

    window.sessionStorage.setItem('falcondeck.remote.session-secrets.v1', firstTabSecrets!)
    expect(loadPersistedRemoteSession()).toMatchObject({
      sessionId: 'session-1',
      clientToken: 'client-token-1',
    })

    window.sessionStorage.setItem('falcondeck.remote.session-secrets.v1', secondTabSecrets!)
    expect(loadPersistedRemoteSession()).toMatchObject({
      sessionId: 'session-2',
      clientToken: 'client-token-2',
    })
  })

  it('clears only the session owned by the resetting tab', () => {
    persistRemoteSession({
      version: REMOTE_SESSION_STORAGE_VERSION,
      relayUrl: 'https://connect.example.com',
      pairingCode: '',
      sessionId: 'session-1',
      clientToken: 'client-token-1',
      clientSecretKey: secretKeyToBase64(generateBoxKeyPair()),
    })
    persistRemoteSession({
      version: REMOTE_SESSION_STORAGE_VERSION,
      relayUrl: 'https://connect.example.com',
      pairingCode: '',
      sessionId: 'session-2',
      clientToken: 'client-token-2',
      clientSecretKey: secretKeyToBase64(generateBoxKeyPair()),
    })

    clearPersistedRemoteSession('session-1')

    expect(window.localStorage.getItem('falcondeck.remote.session.v1:session-1')).toBeNull()
    expect(window.localStorage.getItem('falcondeck.remote.session.v1:session-2')).not.toBeNull()
  })
})

describe('client key-pair persistence', () => {
  it('keeps a valid legacy key when tab storage is temporarily unavailable', () => {
    const keyPair = generateBoxKeyPair()
    const secret = secretKeyToBase64(keyPair)
    window.localStorage.setItem('falcondeck.remote.client-keypair.v1', secret)
    const originalSetItem = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (key, value) {
      if (this === window.sessionStorage) {
        throw new DOMException('storage blocked', 'SecurityError')
      }
      return originalSetItem.call(this, key, value)
    })

    const restored = loadOrCreateClientKeyPair()

    expect(secretKeyToBase64(restored)).toBe(secret)
    expect(window.localStorage.getItem('falcondeck.remote.client-keypair.v1')).toBe(secret)
  })
})

describe('snapshotRetryDelayMs', () => {
  it.each([
    [0, 1_000],
    [1, 2_000],
    [2, 4_000],
    [20, 15_000],
    [-1, 1_000],
  ])('returns a bounded retry delay for attempt %s', (attempt, expected) => {
    expect(snapshotRetryDelayMs(attempt)).toBe(expected)
  })
})

describe('shouldApplyReplayPresence', () => {
  it('accepts replay presence before an authoritative sync is received', () => {
    expect(shouldApplyReplayPresence(1, null)).toBe(true)
  })

  it('rejects replay presence older than the sync next-sequence floor', () => {
    expect(shouldApplyReplayPresence(6, 7)).toBe(false)
  })

  it('accepts presence at or after the sync next-sequence floor', () => {
    expect(shouldApplyReplayPresence(7, 7)).toBe(true)
  })
})

function snapshotWith(workspaceIds: string[], threads: Array<{ id: string; workspace_id: string }>): DaemonSnapshot {
  return {
    workspaces: workspaceIds.map((id) => ({ id })),
    threads,
  } as unknown as DaemonSnapshot
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  })
}

afterEach(() => {
  window.localStorage.clear()
  setVisibility('visible')
  vi.restoreAllMocks()
})

describe('resolveRestoredSelection', () => {
  const snapshot = snapshotWith(
    ['ws-1', 'ws-2'],
    [
      { id: 't-1', workspace_id: 'ws-1' },
      { id: 't-2', workspace_id: 'ws-2' },
    ],
  )

  it('restores a selection that still exists', () => {
    expect(
      resolveRestoredSelection(snapshot, {
        workspaceId: 'ws-1',
        threadId: 't-1',
      }),
    ).toEqual({
      workspaceId: 'ws-1',
      threadId: 't-1',
    })
  })

  it('keeps the workspace but drops a thread that is gone', () => {
    expect(
      resolveRestoredSelection(snapshot, {
        workspaceId: 'ws-1',
        threadId: 'deleted',
      }),
    ).toEqual({ workspaceId: 'ws-1', threadId: null })
  })

  it('drops a thread that moved to another workspace', () => {
    expect(
      resolveRestoredSelection(snapshot, {
        workspaceId: 'ws-1',
        threadId: 't-2',
      }),
    ).toEqual({
      workspaceId: 'ws-1',
      threadId: null,
    })
  })

  it('gives up when the workspace is gone so the snapshot default wins', () => {
    expect(
      resolveRestoredSelection(snapshot, {
        workspaceId: 'gone',
        threadId: 't-1',
      }),
    ).toBeNull()
  })

  it('gives up before a snapshot has arrived', () => {
    expect(resolveRestoredSelection(null, { workspaceId: 'ws-1', threadId: 't-1' })).toBeNull()
  })
})

describe('selection persistence', () => {
  it('round-trips a selection', () => {
    persistSelection('session-1', { workspaceId: 'ws-1', threadId: 't-1' })
    expect(loadPersistedSelection('session-1')).toEqual({
      workspaceId: 'ws-1',
      threadId: 't-1',
    })
  })

  it('clears the stored selection when passed null', () => {
    persistSelection('session-1', { workspaceId: 'ws-1', threadId: 't-1' })
    persistSelection('session-1', null)
    expect(loadPersistedSelection('session-1')).toBeNull()
  })

  it('ignores malformed stored values', () => {
    window.localStorage.setItem('falcondeck.remote.selection.v1:session-1', '{not json')
    expect(loadPersistedSelection('session-1')).toBeNull()
  })

  it('keeps selections isolated between paired sessions', () => {
    persistSelection('session-1', { workspaceId: 'ws-1', threadId: 't-1' })
    persistSelection('session-2', { workspaceId: 'ws-2', threadId: 't-2' })

    expect(loadPersistedSelection('session-1')).toEqual({
      workspaceId: 'ws-1',
      threadId: 't-1',
    })
    expect(loadPersistedSelection('session-2')).toEqual({
      workspaceId: 'ws-2',
      threadId: 't-2',
    })
  })
})

describe('remote snapshot cache', () => {
  const snapshot = snapshotWith(['ws-1'], [{ id: 't-1', workspace_id: 'ws-1' }])

  it('round-trips a normalized snapshot for the same session', () => {
    persistRemoteSnapshot('session-1', snapshot, 42)

    expect(loadPersistedRemoteSnapshot('session-1')).toEqual({
      snapshot: expect.objectContaining({
        workspaces: [expect.objectContaining({ id: 'ws-1' })],
        threads: [expect.objectContaining({ id: 't-1', workspace_id: 'ws-1' })],
      }),
      lastReceivedSeq: 42,
    })
  })

  it('does not delete a cache belonging to another session', () => {
    persistRemoteSnapshot('session-1', snapshot, 42)

    expect(loadPersistedRemoteSnapshot('session-2')).toBeNull()
    expect(loadPersistedRemoteSnapshot('session-1')?.lastReceivedSeq).toBe(42)
  })

  it('keeps independent warm caches for two paired sessions', () => {
    persistRemoteSnapshot('session-1', snapshot, 42)
    persistRemoteSnapshot('session-2', snapshot, 84)

    expect(loadPersistedRemoteSnapshot('session-1')?.lastReceivedSeq).toBe(42)
    expect(loadPersistedRemoteSnapshot('session-2')?.lastReceivedSeq).toBe(84)
  })

  it('clears only the requested session cache', () => {
    persistRemoteSnapshot('session-1', snapshot, 42)
    persistRemoteSnapshot('session-2', snapshot, 84)

    clearPersistedRemoteSnapshot('session-1')

    expect(loadPersistedRemoteSnapshot('session-1')).toBeNull()
    expect(loadPersistedRemoteSnapshot('session-2')?.lastReceivedSeq).toBe(84)
  })

  it('does not clear other tabs when a fresh pairing has no previous session', () => {
    persistRemoteSnapshot('session-1', snapshot, 42)

    clearPersistedRemoteSnapshot(null)

    expect(loadPersistedRemoteSnapshot('session-1')?.lastReceivedSeq).toBe(42)
  })

  it('removes malformed or old cache entries safely', () => {
    window.localStorage.setItem(
      'falcondeck.remote.snapshot.v1',
      JSON.stringify({
        version: 0,
        sessionId: 'session-1',
        snapshot,
        lastReceivedSeq: 42,
      }),
    )
    expect(loadPersistedRemoteSnapshot('session-1')).toBeNull()
    expect(window.localStorage.getItem('falcondeck.remote.snapshot.v1')).toBeNull()

    window.localStorage.setItem('falcondeck.remote.snapshot.v1', '{not json')
    expect(loadPersistedRemoteSnapshot('session-1')).toBeNull()
    expect(window.localStorage.getItem('falcondeck.remote.snapshot.v1')).toBeNull()
  })

  it('keeps the relay cursor independent from the cached snapshot', () => {
    persistRemoteSnapshot('session-1', snapshot, 7)
    expect(loadPersistedRemoteSnapshot('session-1')?.lastReceivedSeq).toBe(7)

    persistRemoteSnapshot('session-1', snapshot, 8)
    expect(loadPersistedRemoteSnapshot('session-1')?.lastReceivedSeq).toBe(8)
  })

  it('only warm-starts when the cache covers the persisted cursor', () => {
    expect(canWarmStartFromSnapshotCache(7, 8)).toBe(false)
    expect(canWarmStartFromSnapshotCache(8, 8)).toBe(true)
    expect(canWarmStartFromSnapshotCache(9, 8)).toBe(true)
  })
})

describe('scheduleVisibilityAwareFlush', () => {
  it('uses requestAnimationFrame while the tab is visible', () => {
    setVisibility('visible')
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockReturnValue(7)
    const cancelRaf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})

    const cancel = scheduleVisibilityAwareFlush(() => {})
    expect(raf).toHaveBeenCalledTimes(1)
    cancel()
    expect(cancelRaf).toHaveBeenCalledWith(7)
  })

  it('falls back to a timer when the tab is hidden, because rAF never fires there', async () => {
    setVisibility('hidden')
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const callback = vi.fn()

    scheduleVisibilityAwareFlush(callback)
    expect(raf).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1))
  })

  it('cancels the hidden-tab timer', async () => {
    setVisibility('hidden')
    const callback = vi.fn()
    const cancel = scheduleVisibilityAwareFlush(callback)
    cancel()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(callback).not.toHaveBeenCalled()
  })
})

describe('createSnapshotCacheScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('lands the first pending image without waiting', () => {
    const write = vi.fn()
    const scheduler = createSnapshotCacheScheduler(write)

    scheduler.schedule()
    expect(write).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(write).toHaveBeenCalledTimes(1)
  })

  it('coalesces a burst into one write per interval with the newest image', () => {
    const write = vi.fn()
    const scheduler = createSnapshotCacheScheduler(write)

    // A stream floods schedule() calls; only the booked trailing timer runs.
    for (let i = 0; i < 50; i += 1) {
      scheduler.schedule()
      vi.advanceTimersByTime(100)
    }
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('keeps writes at least the minimum interval apart while updates flow', () => {
    const write = vi.fn()
    const scheduler = createSnapshotCacheScheduler(write, 5_000)

    scheduler.schedule()
    vi.advanceTimersByTime(0)
    expect(write).toHaveBeenCalledTimes(1)

    // The next update lands a full interval later, however often it schedules.
    scheduler.schedule()
    scheduler.schedule()
    vi.advanceTimersByTime(4_999)
    expect(write).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(write).toHaveBeenCalledTimes(2)

    scheduler.schedule()
    vi.advanceTimersByTime(5_000)
    expect(write).toHaveBeenCalledTimes(3)
  })

  it('flushes immediately on demand and resets the spacing clock', () => {
    const write = vi.fn()
    const scheduler = createSnapshotCacheScheduler(write, 5_000)

    scheduler.schedule()
    scheduler.flush()
    expect(write).toHaveBeenCalledTimes(1)

    // Hide/unload just wrote, so the next scheduled write still waits.
    scheduler.schedule()
    vi.advanceTimersByTime(4_999)
    expect(write).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('ignores a flush with nothing pending and cancels drops the write', () => {
    const write = vi.fn()
    const scheduler = createSnapshotCacheScheduler(write)

    scheduler.flush()
    expect(write).not.toHaveBeenCalled()

    scheduler.schedule()
    scheduler.cancel()
    vi.advanceTimersByTime(10_000)
    expect(write).not.toHaveBeenCalled()
  })
})

describe('boundRetainedThreadItems', () => {
  const item = (id: string) => ({ id }) as ConversationItem
  const cache = (...threadIds: string[]) => Object.fromEntries(threadIds.map((id) => [id, [item(`${id}-item`)]]))
  const thread = (id: string, updated_at: string) => ({ id, updated_at })

  it('drops caches for threads that left the snapshot and keeps identity otherwise', () => {
    const current = cache('t-1', 't-2')
    const threads = [thread('t-1', '2026-08-12T12:00:00Z'), thread('t-2', '2026-08-12T11:00:00Z')]

    expect(boundRetainedThreadItems(current, threads, null)).toBe(current)
    expect(boundRetainedThreadItems(current, [threads[0]!], null)).toEqual(cache('t-1'))
  })

  it('evicts the least recently updated threads beyond the cap', () => {
    // Cap 2, no selection: t-3 is freshest, t-1 is oldest.
    const current = cache('t-1', 't-2', 't-3')
    const threads = [
      thread('t-1', '2026-08-12T08:00:00Z'),
      thread('t-2', '2026-08-12T09:00:00Z'),
      thread('t-3', '2026-08-12T10:00:00Z'),
    ]

    expect(Object.keys(boundRetainedThreadItems(current, threads, null, 2))).toEqual(['t-3', 't-2'])
  })

  it('never evicts the selected thread even when it is the stalest', () => {
    const current = cache('t-1', 't-2', 't-3')
    const threads = [
      thread('t-1', '2026-08-12T08:00:00Z'),
      thread('t-2', '2026-08-12T09:00:00Z'),
      thread('t-3', '2026-08-12T10:00:00Z'),
    ]

    expect(Object.keys(boundRetainedThreadItems(current, threads, 't-1', 2)).sort()).toEqual(['t-1', 't-3'])
  })

  it('rehydrates evicted threads from scratch: a missing cache stays empty-safe', () => {
    const pruned = boundRetainedThreadItems(cache('t-9'), [thread('t-other', '2026-08-12T10:00:00Z')], null, 32)

    expect(pruned).toEqual({})
    // The streaming applier treats an empty base as "no cached items", which
    // the detail RPC then replaces on selection.
    expect(pruned['t-other'] ?? []).toEqual([])
  })
})

describe('resumePendingActions', () => {
  it('aborts the old session generation and resumes with the new credentials', async () => {
    const pendingPolls = new Set<AbortController>()
    const forget = vi.fn()
    const oldPoll = vi.fn(
      (_actionId: string, { signal }: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'))
          })
        }),
    )

    const stopOldSession = resumePendingActions({
      actionIds: ['action-1'],
      clientToken: 'old-token',
      sessionId: 'old-session',
      pendingPolls,
      poll: oldPoll,
      forget,
    })

    expect(oldPoll).toHaveBeenCalledWith(
      'action-1',
      expect.objectContaining({
        clientTokenOverride: 'old-token',
        sessionIdOverride: 'old-session',
      }),
    )
    expect(pendingPolls.size).toBe(1)

    stopOldSession()
    await vi.waitFor(() => expect(pendingPolls.size).toBe(0))
    expect(forget).not.toHaveBeenCalled()

    const newPoll = vi.fn().mockResolvedValue({ ok: true })
    resumePendingActions({
      actionIds: ['action-1'],
      clientToken: 'new-token',
      sessionId: 'new-session',
      pendingPolls,
      poll: newPoll,
      forget,
    })

    await vi.waitFor(() => expect(forget).toHaveBeenCalledWith('action-1'))
    expect(newPoll).toHaveBeenCalledWith(
      'action-1',
      expect.objectContaining({
        clientTokenOverride: 'new-token',
        sessionIdOverride: 'new-session',
      }),
    )
    expect(pendingPolls.size).toBe(0)
  })

  it('forgets terminal actions but retains transient failures for reconnect', async () => {
    const pendingPolls = new Set<AbortController>()
    const forget = vi.fn()

    resumePendingActions({
      actionIds: ['terminal'],
      clientToken: 'token',
      sessionId: 'session',
      pendingPolls,
      poll: vi.fn().mockRejectedValue(new Error('Failed with status 404')),
      forget,
    })
    await vi.waitFor(() => expect(forget).toHaveBeenCalledWith('terminal'))

    forget.mockClear()
    resumePendingActions({
      actionIds: ['transient', 'transient'],
      clientToken: 'token',
      sessionId: 'session',
      pendingPolls,
      poll: vi.fn().mockRejectedValue(new Error('Failed with status 503')),
      forget,
    })
    await vi.waitFor(() => expect(pendingPolls.size).toBe(0))
    expect(forget).not.toHaveBeenCalled()
  })
})

describe('pending action persistence', () => {
  it('keeps durable action recovery isolated between sessions', () => {
    persistPendingActionIds('session-1', ['action-1'])
    persistPendingActionIds('session-2', ['action-2'])

    expect(loadPendingActionIds('session-1')).toEqual(['action-1'])
    expect(loadPendingActionIds('session-2')).toEqual(['action-2'])
  })

  it('deduplicates, rejects blank ids, and bounds corrupt persisted input', () => {
    const actionIds = [
      '',
      '   ',
      'action-1',
      'action-1',
      ...Array.from({ length: MAX_PERSISTED_PENDING_ACTIONS + 20 }, (_, index) => `action-${index + 2}`),
    ]
    window.localStorage.setItem('falcondeck.remote.pending-actions.v1:session-1', JSON.stringify(actionIds))

    const loaded = loadPendingActionIds('session-1')
    expect(loaded).toHaveLength(MAX_PERSISTED_PENDING_ACTIONS)
    expect(loaded.every((actionId) => actionId.trim() === actionId && actionId.length > 0)).toBe(true)
    expect(new Set(loaded).size).toBe(loaded.length)
  })

  it('does not clear other tabs when a fresh pairing has no previous session', () => {
    persistPendingActionIds('session-1', ['action-1'])

    clearPendingActionIds(null)

    expect(loadPendingActionIds('session-1')).toEqual(['action-1'])
  })

  it('retains transient poll failures but forgets terminal outcomes', () => {
    const forget = vi.fn()

    expect(forgetPendingActionAfterError('action-1', new Error('Failed with status 503'), forget)).toBe(false)
    expect(forget).not.toHaveBeenCalled()

    expect(forgetPendingActionAfterError('action-1', new Error('Queued action not found'), forget)).toBe(true)
    expect(forget).toHaveBeenCalledWith('action-1')
  })
})

describe('deviceLabelForUserAgent', () => {
  it.each([
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/128.0.0.0 Mobile/15E148 Safari/604.1',
      'Chrome on iPhone',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 FxiOS/129.0 Mobile/15E148 Safari/605.1.15',
      'Firefox on iPhone',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 EdgiOS/128.0 Mobile/15E148 Safari/605.1.15',
      'Edge on iPhone',
    ],
  ])('labels iOS browsers accurately', (userAgent, expected) => {
    expect(deviceLabelForUserAgent(userAgent)).toBe(expected)
  })

  it('recognizes iPadOS when Safari requests the desktop site', () => {
    const userAgent =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'

    expect(
      deviceLabelForUserAgent(userAgent, {
        platform: 'MacIntel',
        maxTouchPoints: 5,
      }),
    ).toBe('Safari on iPad')
  })
})

describe('urlWithoutPairingParams', () => {
  it('strips a spent pairing code and relay override', () => {
    expect(urlWithoutPairingParams('https://app.falcondeck.com/?code=ABCD&relay=https://r')).toBe('/')
  })

  it('keeps unrelated query parameters', () => {
    expect(urlWithoutPairingParams('https://app.falcondeck.com/x?code=ABCD&debug=1')).toBe('/x?debug=1')
  })

  it('leaves a URL without pairing parameters untouched', () => {
    const href = 'https://app.falcondeck.com/x?debug=1'
    expect(urlWithoutPairingParams(href)).toBe(href)
  })

  it('does not throw on an unparseable value', () => {
    expect(urlWithoutPairingParams('not a url')).toBe('not a url')
  })

  it('rewrites history in place without navigating', () => {
    const replaceState = vi.spyOn(window.history, 'replaceState')
    window.history.replaceState({}, '', '/?code=ABCD')
    replaceState.mockClear()

    clearPairingParamsFromUrl()
    expect(replaceState).toHaveBeenCalledTimes(1)
    expect(window.location.search).toBe('')
  })
})

describe('notification gating', () => {
  it('defaults to not posting until the user opts in', () => {
    expect(loadNotificationPreference()).toBe('default')
    expect(canPostNotifications('default')).toBe(false)
    expect(canPostNotifications('disabled')).toBe(false)
  })

  it('round-trips the opt-in', () => {
    persistNotificationPreference('enabled')
    expect(loadNotificationPreference()).toBe('enabled')
    persistNotificationPreference('default')
    expect(loadNotificationPreference()).toBe('default')
  })

  it('still refuses to post when the browser has not granted permission', () => {
    vi.stubGlobal('Notification', { permission: 'denied' })
    expect(canPostNotifications('enabled')).toBe(false)
    vi.stubGlobal('Notification', { permission: 'granted' })
    expect(canPostNotifications('enabled')).toBe(true)
    vi.unstubAllGlobals()
  })

  it('swallows constructors that throw, as Android Chrome does', () => {
    vi.stubGlobal(
      'Notification',
      class {
        constructor() {
          throw new TypeError('Illegal constructor')
        }
      },
    )
    expect(() => postThreadNotification('title', 'body')).not.toThrow()
    vi.unstubAllGlobals()
  })
})

describe('deriveConnectionHelpState', () => {
  const base = {
    connectionStatus: 'connected as client (encrypted)',
    desktopOnline: true,
    error: null,
    hasSessionKey: true,
    isConnected: true,
  }

  it('stays quiet on a healthy session', () => {
    expect(deriveConnectionHelpState(base)).toBeNull()
  })

  it('keeps the offline banner up across the reconnect backoff', () => {
    const dropped = deriveConnectionHelpState({
      ...base,
      connectionStatus: 'disconnected',
    })
    const retrying = deriveConnectionHelpState({
      ...base,
      connectionStatus: 'connecting',
      isReconnecting: true,
    })
    expect(dropped?.title).toBe('Relay connection dropped')
    expect(retrying?.title).toBe('Relay connection dropped')
  })

  it('does not claim a drop during the very first connect', () => {
    expect(
      deriveConnectionHelpState({
        ...base,
        connectionStatus: 'connecting',
        isConnected: false,
        hasSessionKey: false,
      }),
    ).toBeNull()
  })

  it('explains an expired code instead of falling through to the generic banner', () => {
    const help = deriveConnectionHelpState({
      ...base,
      error: 'pairing has expired',
      isConnected: false,
      hasSessionKey: false,
    })

    expect(help?.title).toBe('This pairing code has expired')
    expect(help?.tone).toBe('warning')
    expect(help?.steps[0]).toMatch(/pair another device/i)
  })

  it('keeps expiry distinct from an already-claimed code', () => {
    const claimed = deriveConnectionHelpState({
      ...base,
      error: 'pairing has already been claimed',
      isConnected: false,
      hasSessionKey: false,
    })

    expect(claimed?.title).toBe('This pairing code has already been used')
  })
})

describe('connectionBadgeState', () => {
  it('does not claim "Connected" before the session key lands', () => {
    expect(connectionBadgeState('connected as client', true, false)).toEqual({
      variant: 'warning',
      label: 'Securing',
    })
  })

  it('distinguishes a healthy session from an absent daemon', () => {
    expect(connectionBadgeState('connected as client (encrypted)', true, true).label).toBe('Connected')
    expect(connectionBadgeState('connected as client (encrypted)', false, true).label).toBe('Desktop retrying')
  })

  it('does not report healthy while snapshot RPC is re-registering', () => {
    expect(connectionBadgeState('connected as client (encrypted)', true, true, false)).toEqual({
      variant: 'warning',
      label: 'Sync repairing',
    })
  })

  it('does not report the desktop offline before presence arrives', () => {
    expect(connectionBadgeState('connected as client (encrypted)', false, true, false, false)).toEqual({
      variant: 'warning',
      label: 'Checking desktop',
    })
  })

  it('reports a dropped socket as an error', () => {
    expect(connectionBadgeState('disconnected', false, true)).toEqual({
      variant: 'danger',
      label: 'Disconnected',
    })
  })
})

describe('AwaitedActionTimeoutError', () => {
  it('says the work is still queued rather than failed', () => {
    expect(new AwaitedActionTimeoutError(false).message).toMatch(/offline/i)
    expect(new AwaitedActionTimeoutError(false).message).toMatch(/queued/i)
    expect(new AwaitedActionTimeoutError(true).message).toMatch(/not answered yet/i)
  })
})

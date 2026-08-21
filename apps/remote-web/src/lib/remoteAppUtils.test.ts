import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DaemonSnapshot } from '@falcondeck/client-core'

import {
  AwaitedActionTimeoutError,
  canPostNotifications,
  canWarmStartFromSnapshotCache,
  clearPairingParamsFromUrl,
  connectionBadgeState,
  deriveConnectionHelpState,
  loadPersistedRemoteSnapshot,
  loadNotificationPreference,
  loadPersistedSelection,
  persistNotificationPreference,
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

function snapshotWith(
  workspaceIds: string[],
  threads: Array<{ id: string; workspace_id: string }>,
): DaemonSnapshot {
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
    expect(resolveRestoredSelection(snapshot, { workspaceId: 'ws-1', threadId: 't-1' })).toEqual({
      workspaceId: 'ws-1',
      threadId: 't-1',
    })
  })

  it('keeps the workspace but drops a thread that is gone', () => {
    expect(
      resolveRestoredSelection(snapshot, { workspaceId: 'ws-1', threadId: 'deleted' }),
    ).toEqual({ workspaceId: 'ws-1', threadId: null })
  })

  it('drops a thread that moved to another workspace', () => {
    expect(resolveRestoredSelection(snapshot, { workspaceId: 'ws-1', threadId: 't-2' })).toEqual({
      workspaceId: 'ws-1',
      threadId: null,
    })
  })

  it('gives up when the workspace is gone so the snapshot default wins', () => {
    expect(resolveRestoredSelection(snapshot, { workspaceId: 'gone', threadId: 't-1' })).toBeNull()
  })

  it('gives up before a snapshot has arrived', () => {
    expect(resolveRestoredSelection(null, { workspaceId: 'ws-1', threadId: 't-1' })).toBeNull()
  })
})

describe('selection persistence', () => {
  it('round-trips a selection', () => {
    persistSelection({ workspaceId: 'ws-1', threadId: 't-1' })
    expect(loadPersistedSelection()).toEqual({ workspaceId: 'ws-1', threadId: 't-1' })
  })

  it('clears the stored selection when passed null', () => {
    persistSelection({ workspaceId: 'ws-1', threadId: 't-1' })
    persistSelection(null)
    expect(loadPersistedSelection()).toBeNull()
  })

  it('ignores malformed stored values', () => {
    window.localStorage.setItem('falcondeck.remote.selection.v1', '{not json')
    expect(loadPersistedSelection()).toBeNull()
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

  it('does not hydrate a cache belonging to another session', () => {
    persistRemoteSnapshot('session-1', snapshot, 42)

    expect(loadPersistedRemoteSnapshot('session-2')).toBeNull()
    expect(window.localStorage.getItem('falcondeck.remote.snapshot.v1')).toBeNull()
  })

  it('removes malformed or old cache entries safely', () => {
    window.localStorage.setItem(
      'falcondeck.remote.snapshot.v1',
      JSON.stringify({ version: 0, sessionId: 'session-1', snapshot, lastReceivedSeq: 42 }),
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

describe('urlWithoutPairingParams', () => {
  it('strips a spent pairing code and relay override', () => {
    expect(urlWithoutPairingParams('https://app.falcondeck.com/?code=ABCD&relay=https://r')).toBe(
      '/',
    )
  })

  it('keeps unrelated query parameters', () => {
    expect(urlWithoutPairingParams('https://app.falcondeck.com/x?code=ABCD&debug=1')).toBe(
      '/x?debug=1',
    )
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
    const dropped = deriveConnectionHelpState({ ...base, connectionStatus: 'disconnected' })
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
    expect(connectionBadgeState('connected as client (encrypted)', true, true).label).toBe(
      'Connected',
    )
    expect(connectionBadgeState('connected as client (encrypted)', false, true).label).toBe(
      'Desktop retrying',
    )
  })

  it('does not report healthy while snapshot RPC is re-registering', () => {
    expect(
      connectionBadgeState('connected as client (encrypted)', true, true, false),
    ).toEqual({
      variant: 'warning',
      label: 'Sync repairing',
    })
  })

  it('does not report the desktop offline before presence arrives', () => {
    expect(
      connectionBadgeState('connected as client (encrypted)', false, true, false, false),
    ).toEqual({
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

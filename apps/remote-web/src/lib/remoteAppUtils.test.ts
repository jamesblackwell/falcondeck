import { afterEach, describe, expect, it, vi } from 'vitest'

import type { DaemonSnapshot } from '@falcondeck/client-core'

import {
  AwaitedActionTimeoutError,
  canPostNotifications,
  clearPairingParamsFromUrl,
  connectionBadgeState,
  deriveConnectionHelpState,
  loadNotificationPreference,
  loadPersistedSelection,
  persistNotificationPreference,
  persistSelection,
  postThreadNotification,
  resolveRestoredSelection,
  scheduleVisibilityAwareFlush,
  urlWithoutPairingParams,
} from './remoteAppUtils'

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

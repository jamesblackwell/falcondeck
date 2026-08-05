import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

import type { DaemonSnapshot } from '@falcondeck/client-core'
import { Platform } from 'react-native'
import { __setIsDevice } from 'expo-device'
import {
  __emitResponse,
  __getChannels,
  __getHandler,
  __reset as resetNotifications,
  __setLastResponse,
  __setPermissions,
  __setPushToken,
  __setPushTokenError,
} from 'expo-notifications'
import { __resetAllStores as resetMMKV } from 'react-native-mmkv'

import { getJson } from '@/storage/mmkv'
import { useSessionStore } from '@/store/session-store'
import {
  __resetInitialNotificationResponseForTests,
  addNotificationResponseListener,
  clearPushToken,
  configureForegroundNotificationHandler,
  ensureAndroidNotificationChannel,
  getPushTokenSafely,
  handleNotificationTapData,
  processInitialNotificationResponse,
  registerPushToken,
} from './push-notifications'

const RELAY_URL = 'https://relay.test'
const SESSION_ID = 'session-1'
const DEVICE_ID = 'device-1'
const CLIENT_TOKEN = 'client-token-1'

function mockFetchOk() {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true }),
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
  return fetchMock
}

function tapResponse(data: unknown) {
  return { actionIdentifier: 'default', notification: { request: { content: { data } } } }
}

describe('push-notifications', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetNotifications()
    resetMMKV()
    __setIsDevice(true)
    __resetInitialNotificationResponseForTests()
    useSessionStore.getState().reset()
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
    vi.restoreAllMocks()
  })

  describe('registerPushToken', () => {
    it('POSTs the token to the relay push-token endpoint', async () => {
      const fetchMock = mockFetchOk()
      __setPushToken('ExponentPushToken[abc]')

      await registerPushToken(RELAY_URL, SESSION_ID, DEVICE_ID, CLIENT_TOKEN)

      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(fetchMock).toHaveBeenCalledWith(
        'https://relay.test/v1/sessions/session-1/devices/device-1/push-token',
        {
          method: 'POST',
          headers: {
            authorization: 'Bearer client-token-1',
            'content-type': 'application/json',
          },
          body: JSON.stringify({ push_token: 'ExponentPushToken[abc]' }),
        },
      )
    })

    it('strips trailing slashes and encodes path segments', async () => {
      const fetchMock = mockFetchOk()

      await registerPushToken('https://relay.test/', 'session with spaces', 'device/1', CLIENT_TOKEN)

      expect(fetchMock.mock.calls[0][0]).toBe(
        'https://relay.test/v1/sessions/session%20with%20spaces/devices/device%2F1/push-token',
      )
    })

    it('dedupes: does not re-POST the same token for the same session and device', async () => {
      const fetchMock = mockFetchOk()

      await registerPushToken(RELAY_URL, SESSION_ID, DEVICE_ID, CLIENT_TOKEN)
      await registerPushToken(RELAY_URL, SESSION_ID, DEVICE_ID, CLIENT_TOKEN)

      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('re-POSTs when the token changes', async () => {
      const fetchMock = mockFetchOk()

      __setPushToken('ExponentPushToken[one]')
      await registerPushToken(RELAY_URL, SESSION_ID, DEVICE_ID, CLIENT_TOKEN)
      __setPushToken('ExponentPushToken[two]')
      await registerPushToken(RELAY_URL, SESSION_ID, DEVICE_ID, CLIENT_TOKEN)

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({
        push_token: 'ExponentPushToken[two]',
      })
    })

    it('re-POSTs when the session changes', async () => {
      const fetchMock = mockFetchOk()

      await registerPushToken(RELAY_URL, SESSION_ID, DEVICE_ID, CLIENT_TOKEN)
      await registerPushToken(RELAY_URL, 'session-2', DEVICE_ID, CLIENT_TOKEN)

      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('re-POSTs when the device changes', async () => {
      const fetchMock = mockFetchOk()

      await registerPushToken(RELAY_URL, SESSION_ID, DEVICE_ID, CLIENT_TOKEN)
      await registerPushToken(RELAY_URL, SESSION_ID, 'device-2', CLIENT_TOKEN)

      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('does not persist the registration when the POST fails, so it retries', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce({ ok: false, status: 500, json: async () => null })
        .mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) })
      globalThis.fetch = fetchMock as unknown as typeof fetch

      await registerPushToken(RELAY_URL, SESSION_ID, DEVICE_ID, CLIENT_TOKEN)
      expect(warnSpy).toHaveBeenCalled()

      await registerPushToken(RELAY_URL, SESSION_ID, DEVICE_ID, CLIENT_TOKEN)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      // Third call is deduped after the successful retry.
      await registerPushToken(RELAY_URL, SESSION_ID, DEVICE_ID, CLIENT_TOKEN)
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    it('never throws on network failure', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch

      await expect(
        registerPushToken(RELAY_URL, SESSION_ID, DEVICE_ID, CLIENT_TOKEN),
      ).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalled()
    })

    it('skips the POST entirely when no push token is available', async () => {
      const fetchMock = mockFetchOk()
      __setPermissions({ granted: false, canAskAgain: false, status: 'denied' })

      await registerPushToken(RELAY_URL, SESSION_ID, DEVICE_ID, CLIENT_TOKEN)

      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('getPushTokenSafely', () => {
    it('returns the Expo push token when permitted on a real device', async () => {
      __setPushToken('ExponentPushToken[xyz]')
      await expect(getPushTokenSafely()).resolves.toBe('ExponentPushToken[xyz]')
    })

    it('returns null on simulators', async () => {
      __setIsDevice(false)
      await expect(getPushTokenSafely()).resolves.toBeNull()
    })

    it('requests permission when not yet granted and proceeds when granted', async () => {
      __setPermissions(
        { granted: false, canAskAgain: true, status: 'undetermined' },
        { granted: true, canAskAgain: true, status: 'granted' },
      )
      await expect(getPushTokenSafely()).resolves.toBe('ExponentPushToken[test]')
    })

    it('returns null when permission stays denied', async () => {
      __setPermissions(
        { granted: false, canAskAgain: true, status: 'undetermined' },
        { granted: false, canAskAgain: false, status: 'denied' },
      )
      await expect(getPushTokenSafely()).resolves.toBeNull()
    })

    it('does not re-prompt when the user already denied permanently', async () => {
      __setPermissions({ granted: false, canAskAgain: false, status: 'denied' })
      await expect(getPushTokenSafely()).resolves.toBeNull()
    })

    it('returns null when the token fetch throws (Expo Go / missing native module)', async () => {
      __setPushTokenError(new Error('No projectId — running in Expo Go'))
      await expect(getPushTokenSafely()).resolves.toBeNull()
      expect(warnSpy).toHaveBeenCalled()
    })
  })

  describe('clearPushToken', () => {
    it('POSTs a null token and forgets the dedupe record', async () => {
      const fetchMock = mockFetchOk()

      await registerPushToken(RELAY_URL, SESSION_ID, DEVICE_ID, CLIENT_TOKEN)
      expect(getJson('push.lastRegistration')).not.toBeNull()

      await clearPushToken(RELAY_URL, SESSION_ID, DEVICE_ID, CLIENT_TOKEN)
      expect(getJson('push.lastRegistration')).toBeNull()
      expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toEqual({ push_token: null })

      // A later registration re-POSTs because the dedupe record is gone.
      await registerPushToken(RELAY_URL, SESSION_ID, DEVICE_ID, CLIENT_TOKEN)
      expect(fetchMock).toHaveBeenCalledTimes(3)
    })

    it('never throws on failure', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch
      await expect(
        clearPushToken(RELAY_URL, SESSION_ID, DEVICE_ID, CLIENT_TOKEN),
      ).resolves.toBeUndefined()
      expect(warnSpy).toHaveBeenCalled()
    })
  })

  describe('foreground notification handler', () => {
    it('suppresses banners, list entries, sounds, and badges while foregrounded', async () => {
      configureForegroundNotificationHandler()
      const handler = __getHandler()
      expect(handler).not.toBeNull()
      await expect(handler!.handleNotification({})).resolves.toEqual({
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      })
    })
  })

  describe('ensureAndroidNotificationChannel', () => {
    it('does nothing on iOS', async () => {
      await ensureAndroidNotificationChannel()
      expect(__getChannels().size).toBe(0)
    })

    it('creates a high-importance default channel on Android', async () => {
      const originalOS = Platform.OS
      ;(Platform as { OS: string }).OS = 'android'
      try {
        await ensureAndroidNotificationChannel()
      } finally {
        ;(Platform as { OS: string }).OS = originalOS
      }
      expect(__getChannels().get('default')).toEqual({
        name: 'Agent attention',
        importance: 4,
      })
    })
  })

  describe('handleNotificationTapData', () => {
    it('selects the workspace and thread when both are present', () => {
      const selectThread = vi.fn()
      useSessionStore.setState({ selectThread })

      expect(handleNotificationTapData({ workspaceId: 'w1', threadId: 't1', kind: 'approval' })).toBe(true)
      expect(selectThread).toHaveBeenCalledWith('w1', 't1')
    })

    it('resolves the workspace from the snapshot when only threadId is present', () => {
      const selectThread = vi.fn()
      useSessionStore.setState({
        selectThread,
        snapshot: {
          workspaces: [],
          threads: [{ id: 't1', workspace_id: 'w1' }],
        } as unknown as DaemonSnapshot,
      })

      expect(handleNotificationTapData({ threadId: 't1', kind: 'question' })).toBe(true)
      expect(selectThread).toHaveBeenCalledWith('w1', 't1')
    })

    it('returns false for an unknown thread without workspace', () => {
      const selectThread = vi.fn()
      useSessionStore.setState({ selectThread, snapshot: null })

      expect(handleNotificationTapData({ threadId: 't-unknown' })).toBe(false)
      expect(selectThread).not.toHaveBeenCalled()
    })

    it('selects only the workspace when threadId is absent', () => {
      const selectWorkspace = vi.fn()
      useSessionStore.setState({ selectWorkspace })

      expect(handleNotificationTapData({ workspaceId: 'w1', kind: 'approval' })).toBe(true)
      expect(selectWorkspace).toHaveBeenCalledWith('w1')
    })

    it('ignores payloads without routable data', () => {
      expect(handleNotificationTapData(null)).toBe(false)
      expect(handleNotificationTapData(undefined)).toBe(false)
      expect(handleNotificationTapData('string')).toBe(false)
      expect(handleNotificationTapData({ kind: 'approval' })).toBe(false)
      expect(handleNotificationTapData({ workspaceId: 42, threadId: true })).toBe(false)
    })
  })

  describe('notification response listeners', () => {
    it('routes taps delivered to the response listener', () => {
      const selectThread = vi.fn()
      useSessionStore.setState({ selectThread })

      const subscription = addNotificationResponseListener()
      expect(subscription).not.toBeNull()

      __emitResponse(tapResponse({ workspaceId: 'w1', threadId: 't1', kind: 'approval' }))
      expect(selectThread).toHaveBeenCalledWith('w1', 't1')

      subscription!.remove()
      __emitResponse(tapResponse({ workspaceId: 'w2', threadId: 't2', kind: 'approval' }))
      expect(selectThread).toHaveBeenCalledTimes(1)
    })

    it('processes the notification that cold-started the app exactly once', async () => {
      const selectThread = vi.fn()
      useSessionStore.setState({ selectThread })
      __setLastResponse(tapResponse({ workspaceId: 'w1', threadId: 't1', kind: 'question' }))

      await processInitialNotificationResponse()
      await processInitialNotificationResponse()

      expect(selectThread).toHaveBeenCalledTimes(1)
      expect(selectThread).toHaveBeenCalledWith('w1', 't1')
    })

    it('is a no-op when the app was not launched from a notification', async () => {
      const selectThread = vi.fn()
      useSessionStore.setState({ selectThread })
      __setLastResponse(null)

      await processInitialNotificationResponse()
      expect(selectThread).not.toHaveBeenCalled()
    })
  })
})

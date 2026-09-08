import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, renderComponent } from '@/test/render'

const mocks = vi.hoisted(() => ({
  restore: vi.fn(), hydrate: vi.fn(), load: vi.fn(), connect: vi.fn(),
  initialNotification: vi.fn(), schedule: vi.fn(), cancel: vi.fn(), reset: vi.fn(),
  selected: null as string | null,
}))
vi.mock('@/theme/unistyles', () => ({}))
vi.mock('react-native-gesture-handler', () => ({ GestureHandlerRootView: 'Root' }))
vi.mock('react-native-safe-area-context', () => ({ SafeAreaProvider: 'SafeArea' }))
vi.mock('react-native', () => ({ InteractionManager: { runAfterInteractions: mocks.schedule } }))
vi.mock('expo-router', () => ({ Slot: 'Slot', useRouter: () => ({ navigate: vi.fn() }) }))
vi.mock('expo-status-bar', () => ({ StatusBar: 'StatusBar' }))
vi.mock('expo-splash-screen', () => ({ preventAutoHideAsync: vi.fn(), hideAsync: vi.fn() }))
vi.mock('@/hooks/useRelayConnection', () => ({ useRelayConnection: () => mocks.connect(mocks.selected) }))
vi.mock('@/lib/push-notifications', () => ({
  configureForegroundNotificationHandler: vi.fn(), ensureAndroidNotificationChannel: vi.fn(),
  addNotificationResponseListener: vi.fn(), processInitialNotificationResponse: mocks.initialNotification,
}))
vi.mock('@/storage/mobile-session-cache', () => ({ clearMobileSessionCache: vi.fn(), loadMobileSessionCache: mocks.load }))
vi.mock('@/store', () => ({
  useRelayStore: { getState: () => ({ restoreSession: mocks.restore }) },
  useSessionStore: { getState: () => ({ hydrateCache: mocks.hydrate, reset: mocks.reset }) },
}))
vi.mock('@/store/ui-store', () => ({ clearEncryptedComposerPersistence: vi.fn(), hydrateEncryptedComposerPersistence: vi.fn() }))
vi.mock('@/features/updates/OtaUpdateBanner', () => ({ OtaUpdateBanner: 'OtaUpdateBanner' }))
import RootLayout from '../app/_layout'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.selected = null
  mocks.restore.mockResolvedValue(true)
  mocks.load.mockReturnValue({ selectedThreadId: 'last-thread' })
  mocks.hydrate.mockImplementation((cache) => { mocks.selected = cache.selectedThreadId })
  mocks.schedule.mockReturnValue({ cancel: mocks.cancel })
})
afterEach(cleanup)

it('waits for deferred cache restoration before connecting with the last conversation', async () => {
  await act(async () => { renderComponent(<RootLayout />) })
  expect(mocks.schedule).toHaveBeenCalledOnce()
  expect(mocks.connect).not.toHaveBeenCalled()
  expect(mocks.initialNotification).not.toHaveBeenCalled()
  await act(async () => { mocks.schedule.mock.calls[0][0]() })
  expect(mocks.connect).toHaveBeenCalledWith('last-thread')
  expect(mocks.initialNotification).toHaveBeenCalled()
})

it.each([true, false])('connects without a cache after restoration (authenticated: %s)', async (restored) => {
  mocks.restore.mockResolvedValue(restored)
  mocks.load.mockReturnValue(null)
  await act(async () => { renderComponent(<RootLayout />) })
  expect(mocks.connect).not.toHaveBeenCalled()
  await act(async () => { mocks.schedule.mock.calls[0][0]() })
  expect(mocks.connect).toHaveBeenCalledWith(null)
  expect(mocks.hydrate).not.toHaveBeenCalled()
})

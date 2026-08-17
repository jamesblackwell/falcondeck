import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { invoke } from '@tauri-apps/api/core'

import { sendDesktopAttentionNotification } from './desktop-notifications'

vi.mock('@tauri-apps/plugin-notification', () => ({
  isPermissionGranted: vi.fn(),
  requestPermission: vi.fn(),
  sendNotification: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}))

const mockedIsPermissionGranted = vi.mocked(isPermissionGranted)
const mockedRequestPermission = vi.mocked(requestPermission)
const mockedSendNotification = vi.mocked(sendNotification)
const mockedInvoke = vi.mocked(invoke)

describe('sendDesktopAttentionNotification', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete window.__TAURI_INTERNALS__
    mockedInvoke.mockResolvedValue('unsupported')
  })

  it('does not call the native plugin in a browser', async () => {
    await expect(
      sendDesktopAttentionNotification({ title: 'FalconDeck', body: 'Hello' }),
    ).resolves.toBe(false)

    expect(mockedIsPermissionGranted).not.toHaveBeenCalled()
    expect(mockedSendNotification).not.toHaveBeenCalled()
  })

  it('sends immediately when native permission is already granted', async () => {
    window.__TAURI_INTERNALS__ = {}
    mockedIsPermissionGranted.mockResolvedValue(true)

    await expect(
      sendDesktopAttentionNotification({
        title: 'Thread needs attention',
        body: 'The agent needs a response in this thread.',
      }),
    ).resolves.toBe(true)

    expect(mockedRequestPermission).not.toHaveBeenCalled()
    expect(mockedSendNotification).toHaveBeenCalledWith({
      title: 'Thread needs attention',
      body: 'The agent needs a response in this thread.',
      sound: 'Ping',
    })
  })

  it('requests permission before sending when needed', async () => {
    window.__TAURI_INTERNALS__ = {}
    mockedIsPermissionGranted.mockResolvedValue(false)
    mockedRequestPermission.mockResolvedValue('granted')

    await expect(
      sendDesktopAttentionNotification({ title: 'FalconDeck', body: 'Done' }),
    ).resolves.toBe(true)

    expect(mockedRequestPermission).toHaveBeenCalledOnce()
    expect(mockedSendNotification).toHaveBeenCalledOnce()
  })

  it('does not send when permission is denied', async () => {
    window.__TAURI_INTERNALS__ = {}
    mockedIsPermissionGranted.mockResolvedValue(false)
    mockedRequestPermission.mockResolvedValue('denied')

    await expect(
      sendDesktopAttentionNotification({ title: 'FalconDeck', body: 'Done' }),
    ).resolves.toBe(false)

    expect(mockedSendNotification).not.toHaveBeenCalled()
  })

  it('uses the native macOS permission and delivery path', async () => {
    window.__TAURI_INTERNALS__ = {}
    mockedInvoke
      .mockResolvedValueOnce('default')
      .mockResolvedValueOnce('granted')
      .mockResolvedValueOnce(undefined)

    await expect(
      sendDesktopAttentionNotification({ title: 'FalconDeck', body: 'Done' }),
    ).resolves.toBe(true)

    expect(mockedInvoke.mock.calls).toEqual([
      ['macos_notification_permission_state'],
      ['request_macos_notification_permission'],
      ['send_macos_notification', { title: 'FalconDeck', body: 'Done' }],
    ])
    expect(mockedSendNotification).not.toHaveBeenCalled()
  })

  it('reports native macOS delivery failures instead of deduplicating them', async () => {
    window.__TAURI_INTERNALS__ = {}
    mockedInvoke
      .mockResolvedValueOnce('granted')
      .mockRejectedValueOnce(new Error('notification rejected'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    await expect(
      sendDesktopAttentionNotification({ title: 'FalconDeck', body: 'Done' }),
    ).resolves.toBe(false)

    expect(mockedSendNotification).not.toHaveBeenCalled()
  })
})

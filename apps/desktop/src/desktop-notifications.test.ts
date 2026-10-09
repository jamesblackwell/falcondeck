import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from '@tauri-apps/plugin-notification'
import { invoke } from '@tauri-apps/api/core'

import type { InteractiveRequest, NotificationPreferences, ThreadSummary } from '@falcondeck/client-core'
import { desktopAttentionNotification, sendDesktopAttentionNotification } from './desktop-notifications'

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

describe('desktop attention events', () => {
  const preferences: NotificationPreferences = {
    enabled: true,
    notify_on_turn_complete: true,
    notify_on_input_required: true,
    notify_on_error: true,
    suppress_when_desktop_active: true,
  }
  const thread = {
    id: 'task', workspace_id: 'workspace', title: 'Review changes',
    status: 'idle', latest_turn_id: 'turn-1', is_archived: false,
    attention: {
      level: 'unread', unread: true, last_agent_activity_seq: 10, last_read_seq: 0,
      pending_approval_count: 0, pending_question_count: 0,
    },
  } as ThreadSummary

  it('allows desktop alerts while phone pushes are suppressed', () => {
    expect(desktopAttentionNotification(thread, [], preferences)?.body).toBe('The latest turn finished.')
  })

  it('distinguishes consecutive completed turns without requiring a read', () => {
    const first = desktopAttentionNotification(thread, [], preferences)
    const second = desktopAttentionNotification({ ...thread, latest_turn_id: 'turn-2' }, [], preferences)
    expect(first?.key).not.toBe(second?.key)
    expect(desktopAttentionNotification({
      ...thread, updated_at: '2026-10-09T12:30:00Z',
    }, [], preferences)?.key).toBe(first?.key)
  })

  it('distinguishes new questions without alerting again for the same request', () => {
    const waiting = {
      ...thread, status: 'waiting_for_input' as const,
      attention: { ...thread.attention, pending_question_count: 1 },
    }
    const request = {
      workspace_id: thread.workspace_id, thread_id: thread.id, request_id: 'question-1', kind: 'question',
    } as InteractiveRequest
    const first = desktopAttentionNotification(waiting, [request], preferences)
    expect(desktopAttentionNotification({
      ...waiting, attention: { ...waiting.attention, last_agent_activity_seq: 11 },
    }, [request], preferences)?.key).toBe(first?.key)
    expect(desktopAttentionNotification(waiting, [{
      ...request, request_id: 'question-2',
    }], preferences)?.key).not.toBe(first?.key)
  })

  it('does not alert on read failures, running tasks, or archived tasks', () => {
    expect(desktopAttentionNotification({
      ...thread, status: 'error', attention: { ...thread.attention, unread: false, last_read_seq: 10 },
    }, [], preferences)).toBeNull()
    expect(desktopAttentionNotification({ ...thread, status: 'running' }, [], preferences)).toBeNull()
    expect(desktopAttentionNotification({ ...thread, is_archived: true }, [], preferences)).toBeNull()
  })

  it('honors the master switch and individual event preferences', () => {
    expect(desktopAttentionNotification(thread, [], { ...preferences, enabled: false })).toBeNull()
    expect(desktopAttentionNotification(thread, [], { ...preferences, notify_on_turn_complete: false })).toBeNull()
    expect(desktopAttentionNotification({ ...thread, status: 'error' }, [], {
      ...preferences, notify_on_error: false,
    })).toBeNull()
  })
})

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

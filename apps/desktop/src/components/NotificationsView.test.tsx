import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NotificationRecord } from '@falcondeck/client-core'

import type { NotificationCentre } from '../hooks/useNotificationCentre'
import { NotificationsView } from './NotificationsView'

vi.mock('@falcondeck/chat-ui', () => ({
  MessageMarkdown: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div>,
  LocalPathProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

const today = new Date().toISOString()
const yesterday = new Date(Date.now() - 86_400_000).toISOString()

function row(overrides: Partial<NotificationRecord>): NotificationRecord {
  return {
    id: 'N-1',
    seq: 1,
    kind: 'turn_complete',
    title: 'Fix login',
    preview: 'Tests pass.',
    created_at: today,
    importance: 'normal',
    has_body: false,
    repeat_count: 0,
    ...overrides,
  }
}

function centre(overrides: Partial<NotificationCentre> = {}): NotificationCentre {
  return {
    records: [],
    counts: { unread_count: 0, needs_you_count: 0, latest_seq: 0 },
    filter: 'all',
    setFilter: vi.fn(),
    loading: false,
    loadingMore: false,
    hasMore: false,
    error: null,
    unsupported: false,
    refresh: vi.fn(async () => {}),
    loadMore: vi.fn(async () => {}),
    markRead: vi.fn(async () => {}),
    markAllRead: vi.fn(async () => {}),
    ...overrides,
  }
}

function view(value: NotificationCentre, getNotification = vi.fn()) {
  const onOpenThread = vi.fn()
  const onOpenReview = vi.fn()
  render(
    <NotificationsView
      centre={value}
      api={{ getNotification }}
      onOpenThread={onOpenThread}
      onOpenReview={onOpenReview}
      onPreview={vi.fn()}
    />,
  )
  return { onOpenThread, onOpenReview }
}

afterEach(cleanup)

describe('NotificationsView', () => {
  it('groups by day and marks what is unread', () => {
    view(centre({
      records: [row({ id: 'N-2', seq: 2, title: 'New' }), row({ read_at: today, created_at: yesterday, title: 'Old' })],
      counts: { unread_count: 1, needs_you_count: 0, latest_seq: 2 },
    }))
    expect(within(screen.getByRole('region', { name: 'Today' })).getByRole('button', { name: /Unread: New/ })).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Yesterday' })).getByRole('button', { name: /^Old/ })).toBeTruthy()
    expect(screen.getByText('1 unread')).toBeTruthy()
  })

  it('offers the three filters', () => {
    const setFilter = vi.fn()
    view(centre({ setFilter, filter: 'needs_you' }))
    const group = within(screen.getByRole('group', { name: 'Filter notifications' }))
    expect(group.getAllByRole('button').map((button) => button.textContent)).toEqual(['All', 'Needs you', 'From bots'])
    expect(group.getByRole('button', { name: 'Needs you' }).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(group.getByRole('button', { name: 'From bots' }))
    expect(setFilter).toHaveBeenCalledWith('bots')
    expect(screen.getByText('Nothing needs you')).toBeTruthy()
  })

  it('deep links to a thread and marks it read', () => {
    const value = centre({ records: [row({ target: { type: 'thread', workspace_id: 'w', thread_id: 't' } })] })
    const { onOpenThread } = view(value)
    fireEvent.click(screen.getByRole('button', { name: /Fix login/ }))
    expect(value.markRead).toHaveBeenCalledWith('N-1')
    expect(onOpenThread).toHaveBeenCalledWith('w', 't')
  })

  it('deep links to a review and marks it read', () => {
    const value = centre({ records: [row({ kind: 'review', target: { type: 'review', review_id: 'R-7' } })] })
    const { onOpenReview } = view(value)
    fireEvent.click(screen.getByRole('button', { name: /Fix login/ }))
    expect(value.markRead).toHaveBeenCalledWith('N-1')
    expect(onOpenReview).toHaveBeenCalledWith('R-7')
  })

  it('opens a report as markdown, with its task as the way out', async () => {
    const record = row({ kind: 'agent_notice', has_body: true, bot: 'Juno', workspace_id: 'w', thread_id: 't' })
    const getNotification = vi.fn(async () => ({ ...record, body: '# Report' }))
    const value = centre({ records: [record] })
    const { onOpenThread } = view(value, getNotification)
    fireEvent.click(screen.getByRole('button', { name: /Fix login/ }))
    await waitFor(() => expect(screen.getByTestId('markdown').textContent).toBe('# Report'))
    expect(getNotification).toHaveBeenCalledWith('N-1')
    expect(value.markRead).toHaveBeenCalledWith('N-1')
    fireEvent.click(screen.getByRole('button', { name: 'Open task' }))
    expect(onOpenThread).toHaveBeenCalledWith('w', 't')
    fireEvent.click(screen.getByRole('button', { name: 'Back to notifications' }))
    expect(screen.getByRole('group', { name: 'Filter notifications' })).toBeTruthy()
  })

  it('says when a report has gone', async () => {
    const record = row({ kind: 'agent_notice', has_body: true })
    view(centre({ records: [record] }), vi.fn(async () => {
      throw Object.assign(new Error('Not found'), { status: 404 })
    }))
    fireEvent.click(screen.getByRole('button', { name: /Fix login/ }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/no longer available/))
  })

  it('opens the report a banner asked for', async () => {
    const record = row({ kind: 'agent_notice', has_body: true })
    const getNotification = vi.fn(async () => ({ ...record, body: 'Banner body' }))
    const value = centre({ records: [record] })
    render(
      <NotificationsView
        centre={value}
        api={{ getNotification }}
        openRequest={{ id: 'N-1', key: 1 }}
        onOpenThread={vi.fn()}
        onOpenReview={vi.fn()}
        onPreview={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByTestId('markdown').textContent).toBe('Banner body'))
    expect(value.markRead).toHaveBeenCalledWith('N-1')
  })

  it('marks all read, and offers nothing when all is read', () => {
    const value = centre({ records: [row({})], counts: { unread_count: 1, needs_you_count: 0, latest_seq: 1 } })
    view(value)
    fireEvent.click(screen.getByRole('button', { name: 'Mark all read' }))
    expect(value.markAllRead).toHaveBeenCalled()
    cleanup()
    view(centre({ records: [row({ read_at: today })] }))
    expect((screen.getByRole('button', { name: 'Mark all read' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows older records on request', () => {
    const value = centre({ records: [row({})], hasMore: true })
    view(value)
    fireEvent.click(screen.getByRole('button', { name: 'Show older' }))
    expect(value.loadMore).toHaveBeenCalled()
  })
})

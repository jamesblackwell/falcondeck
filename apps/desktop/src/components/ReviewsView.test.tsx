import { useState } from 'react'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Review, ReviewDraft } from '@falcondeck/client-core'

import type { ReviewInbox } from '../hooks/useReviewInbox'
import { ReviewsView } from './ReviewsView'

vi.mock('@falcondeck/chat-ui', () => ({
  MessageMarkdown: ({ text }: { text: string }) => <div>{text}</div>,
  BotMark: () => <span data-testid="bot-mark" />,
  LocalPathProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

function review(overrides: Partial<Review> = {}): Review {
  return {
    id: 'R-1',
    title: 'Pricing page',
    ask: 'Ship the new hero?',
    recommendation: 'Ship B.',
    going_ahead_at: null,
    body: 'Context **body**',
    status: 'open',
    items: [
      {
        id: 'i1',
        title: 'Hero',
        note: 'Bigger CTA',
        evidence: [
          { id: 'e1', kind: 'image', title: 'Hero B', caption: null, open_path: '/state/hero.png', original_path: null, snapshotted: true, url: null, content_type: 'image/png', size_bytes: 900 },
          { id: 'e2', kind: 'file', title: null, caption: null, open_path: '/state/spec.pdf', original_path: null, snapshotted: true, url: null, content_type: 'application/pdf', size_bytes: 2048 },
        ],
        decision: null,
        feedback: null,
      },
      { id: 'i2', title: 'Footer', note: '', evidence: [], decision: null, feedback: null },
    ],
    source_thread_id: 'thread-1',
    source_workspace_id: 'workspace-1',
    bot: 'Juno',
    created_by: { name: 'Juno', context: { origin: 'mcp' } },
    created_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    updated_at: new Date().toISOString(),
    folder: null,
    responded_at: null,
    overall_decision: null,
    overall_note: null,
    delivery: null,
    ...overrides,
  } as Review
}

function Harness({
  initial,
  api,
  onPreview = vi.fn(),
}: {
  initial: Review[]
  api: Parameters<typeof ReviewsView>[0]['api']
  onPreview?: (target: unknown) => void
}) {
  const [reviews, setReviews] = useState(initial)
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({})
  const inbox: ReviewInbox = {
    reviews,
    openCount: reviews.filter((r) => r.status === 'open').length,
    loading: false,
    error: null,
    refresh: async () => undefined,
    accept: (next) => setReviews((rows) => rows.map((row) => (row.id === next.id ? next : row))),
    drafts,
    updateDraft: (id, change) => setDrafts((current) => ({ ...current, [id]: change(current[id] ?? { items: {} }) })),
    clearDraft: (id) =>
      setDrafts((current) => {
        const next = { ...current }
        delete next[id]
        return next
      }),
  }
  return <ReviewsView inbox={inbox} api={api} onPreview={onPreview as never} />
}

function makeApi(overrides: Record<string, unknown> = {}) {
  return {
    readReview: vi.fn(),
    respondReview: vi.fn(),
    withdrawReview: vi.fn(),
    readFile: vi.fn(async () => ({ blob: new Blob(['x'], { type: 'image/png' }), version: null })),
    ...overrides,
  } as unknown as NonNullable<Parameters<typeof ReviewsView>[0]['api']> & Record<string, ReturnType<typeof vi.fn>>
}

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => 'blob:thumb')
  URL.revokeObjectURL = vi.fn()
})
afterEach(cleanup)

describe('Reviews list', () => {
  it('lists open reviews first with item counts, and answered ones in a quieter history', () => {
    render(
      <Harness
        api={makeApi()}
        initial={[
          review(),
          review({ id: 'R-2', title: 'Old packet', status: 'approved', responded_at: new Date().toISOString(), items: [{ id: 'i1', title: 'A', note: '', evidence: [], decision: 'approve', feedback: null }] }),
        ]}
      />,
    )
    const open = screen.getByRole('region', { name: 'Open reviews' })
    expect(within(open).getByRole('button', { name: 'R-1 Pricing page' })).toBeInTheDocument()
    expect(within(open).getByText('2 items')).toBeInTheDocument()
    const history = screen.getByRole('region', { name: 'History' })
    expect(within(history).getByRole('button', { name: 'R-2 Old packet' })).toBeInTheDocument()
    expect(within(history).getByText('Approved')).toBeInTheDocument()
    expect(screen.getByText('1 waiting on you')).toBeInTheDocument()
  })

  it('shows an empty state with no reviews', () => {
    render(<Harness api={makeApi()} initial={[]} />)
    expect(screen.getByText('Nothing to review')).toBeInTheDocument()
  })

  it('opens the newest open review by default and switches on click', () => {
    render(<Harness api={makeApi()} initial={[review(), review({ id: 'R-2', title: 'Second', created_at: new Date().toISOString() })]} />)
    expect(screen.getByRole('article', { name: /R-2: Second/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'R-1 Pricing page' }))
    expect(screen.getByRole('article', { name: /R-1: Pricing page/ })).toBeInTheDocument()
  })
})

describe('Review detail', () => {
  it('shows ask, recommendation, body, items, evidence and the going-ahead time', async () => {
    const onPreview = vi.fn()
    render(<Harness api={makeApi()} initial={[review({ going_ahead_at: new Date(Date.now() + 3_600_000).toISOString() })]} onPreview={onPreview} />)
    expect(screen.getAllByText('Ship the new hero?').length).toBeGreaterThan(0)
    expect(screen.getByRole('region', { name: 'Recommendation' })).toHaveTextContent('Ship B.')
    expect(screen.getByText('Context **body**')).toBeInTheDocument()
    expect(screen.getByText(/Going ahead at .* unless you say no/)).toBeInTheDocument()
    const thumb = await screen.findByRole('button', { name: 'Open Hero B' })
    await waitFor(() => expect(within(thumb).getByRole('img')).toHaveAttribute('src', 'blob:thumb'))
    fireEvent.click(thumb)
    expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ path: '/state/hero.png', workspaceId: 'workspace-1', threadId: 'thread-1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open spec.pdf' }))
    expect(onPreview).toHaveBeenLastCalledWith(expect.objectContaining({ path: '/state/spec.pdf' }))
    expect(screen.getByText('2 KB')).toBeInTheDocument()
  })

  it('disables submit and says what is missing until every item is decided', () => {
    render(<Harness api={makeApi()} initial={[review()]} />)
    const send = screen.getByRole('button', { name: 'Send decision' })
    expect(send).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Decide 2 more items, or choose one decision for the whole review.')
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Decision for Hero' })).getByRole('radio', { name: 'Approve' }))
    expect(screen.getByRole('status')).toHaveTextContent('Decide 1 more item')
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Decision for Footer' })).getByRole('radio', { name: 'Reject' }))
    expect(send).toBeEnabled()
  })

  it('a whole-review decision alone enables submit', () => {
    render(<Harness api={makeApi()} initial={[review()]} />)
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Decision for the whole review' })).getByRole('radio', { name: 'Approve' }))
    expect(screen.getByRole('button', { name: 'Send decision' })).toBeEnabled()
  })

  it('moves the choice with arrow keys', () => {
    render(<Harness api={makeApi()} initial={[review()]} />)
    const group = screen.getByRole('radiogroup', { name: 'Decision for Hero' })
    const approve = within(group).getByRole('radio', { name: 'Approve' })
    fireEvent.click(approve)
    fireEvent.keyDown(approve, { key: 'ArrowRight' })
    expect(within(group).getByRole('radio', { name: 'Request changes' })).toHaveAttribute('aria-checked', 'true')
  })

  it('sends per-item decisions, trimmed feedback and the overall note', async () => {
    const closed = review({ status: 'changes_requested', responded_at: new Date().toISOString() })
    const api = makeApi({ respondReview: vi.fn(async () => closed) })
    render(<Harness api={api} initial={[review()]} />)
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Decision for Hero' })).getByRole('radio', { name: 'Request changes' }))
    fireEvent.change(screen.getByLabelText('Feedback for Hero'), { target: { value: '  Make it bigger  ' } })
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Decision for Footer' })).getByRole('radio', { name: 'Approve' }))
    fireEvent.change(screen.getByLabelText('Note on the whole review'), { target: { value: 'Otherwise good' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send decision' }))
    await waitFor(() =>
      expect(api.respondReview).toHaveBeenCalledWith({
        review_id: 'R-1',
        items: [
          { item_id: 'i1', decision: 'request_changes', feedback: 'Make it bigger' },
          { item_id: 'i2', decision: 'approve' },
        ],
        note: 'Otherwise good',
      }),
    )
    // The record becomes read-only.
    expect(await screen.findByRole('region', { name: 'Your response' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send decision' })).toBeNull()
  })

  it('keeps typed text and shows the error when sending fails', async () => {
    const api = makeApi({
      respondReview: vi.fn(async () => {
        throw new Error('Daemon unreachable')
      }),
      readReview: vi.fn(async () => review()),
    })
    render(<Harness api={api} initial={[review()]} />)
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Decision for the whole review' })).getByRole('radio', { name: 'Reject' }))
    fireEvent.change(screen.getByLabelText('Feedback for Hero'), { target: { value: 'Not this' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send decision' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Daemon unreachable')
    expect(screen.getByLabelText('Feedback for Hero')).toHaveValue('Not this')
    expect(screen.getByRole('button', { name: 'Send decision' })).toBeEnabled()
  })

  it('handles review_closed: shows the closed record and keeps what was typed readable', async () => {
    const answered = review({ status: 'approved', responded_at: new Date().toISOString() })
    const api = makeApi({
      respondReview: vi.fn(async () => {
        throw new Error('R-1 is already approved.')
      }),
      readReview: vi.fn(async () => answered),
    })
    render(<Harness api={api} initial={[review()]} />)
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Decision for the whole review' })).getByRole('radio', { name: 'Reject' }))
    fireEvent.change(screen.getByLabelText('Feedback for Hero'), { target: { value: 'Not this' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send decision' }))
    expect(await screen.findByText(/already approved/)).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Unsent draft' })).toHaveTextContent('Not this')
    expect(screen.queryByRole('button', { name: 'Send decision' })).toBeNull()
  })

  it('dismisses a stale open review after a confirmation', async () => {
    const withdrawn = review({ status: 'withdrawn' })
    const api = makeApi({ withdrawReview: vi.fn(async () => withdrawn) })
    render(<Harness api={api} initial={[review()]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(api.withdrawReview).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss review' }))
    await waitFor(() => expect(api.withdrawReview).toHaveBeenCalledWith('R-1'))
    expect(await screen.findByRole('region', { name: 'Your response' })).toHaveTextContent('Withdrawn')
    expect(screen.queryByRole('button', { name: 'Dismiss review' })).toBeNull()
  })

  it('shows a failed delivery on an answered review', () => {
    render(
      <Harness
        api={makeApi()}
        initial={[
          review({
            status: 'approved',
            responded_at: new Date().toISOString(),
            delivery: { state: 'failed', at: new Date().toISOString(), error: 'source thread is gone' },
          }),
        ]}
      />,
    )
    expect(screen.getByText(/didn’t reach the agent: source thread is gone/)).toBeInTheDocument()
    expect(screen.getByText('Not delivered')).toBeInTheDocument()
  })
})

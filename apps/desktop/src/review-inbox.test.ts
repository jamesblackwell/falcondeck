import { describe, expect, it } from 'vitest'
import type { Review, ReviewDraft } from '@falcondeck/client-core'

import {
  draftHasContent,
  evidenceChip,
  formatBytes,
  goingAhead,
  newlyOpenReviews,
  openReviewCount,
  reviewAge,
  reviewBadgeLabel,
  reviewNotification,
  reviewSections,
  submitState,
} from './review-inbox'

function review(overrides: Partial<Review> = {}): Review {
  return {
    id: 'R-1',
    title: 'Pricing page',
    ask: 'Ship the new hero?',
    recommendation: 'Ship B.',
    going_ahead_at: null,
    body: '',
    status: 'open',
    items: [
      { id: 'i1', title: 'Hero', note: '', evidence: [], decision: null, feedback: null },
      { id: 'i2', title: 'Footer', note: '', evidence: [], decision: null, feedback: null },
    ],
    source_thread_id: 'thread-1',
    source_workspace_id: 'workspace-1',
    bot: 'Juno',
    created_by: { name: 'Juno', context: { origin: 'mcp' } },
    created_at: '2026-11-01T10:00:00Z',
    updated_at: '2026-11-01T10:00:00Z',
    folder: null,
    responded_at: null,
    overall_decision: null,
    overall_note: null,
    delivery: null,
    ...overrides,
  } as Review
}

const NOW = Date.parse('2026-11-01T12:00:00Z')

describe('list model', () => {
  it('splits open from history and orders each', () => {
    const rows = [
      review({ id: 'R-1', created_at: '2026-11-01T08:00:00Z' }),
      review({ id: 'R-2', created_at: '2026-11-01T09:00:00Z' }),
      review({ id: 'R-3', status: 'approved', responded_at: '2026-11-01T09:30:00Z' }),
      review({ id: 'R-4', status: 'withdrawn', updated_at: '2026-11-01T11:00:00Z' }),
    ]
    const sections = reviewSections(rows)
    expect(sections.open.map((r) => r.id)).toEqual(['R-2', 'R-1'])
    expect(sections.history.map((r) => r.id)).toEqual(['R-4', 'R-3'])
    expect(openReviewCount(rows)).toBe(2)
  })

  it('formats ages and the badge', () => {
    expect(reviewAge('2026-11-01T11:59:40Z', NOW)).toBe('now')
    expect(reviewAge('2026-11-01T11:35:00Z', NOW)).toBe('25m')
    expect(reviewAge('2026-11-01T09:00:00Z', NOW)).toBe('3h')
    expect(reviewAge('2026-10-30T12:00:00Z', NOW)).toBe('2d')
    expect(reviewBadgeLabel(0)).toBeNull()
    expect(reviewBadgeLabel(3)).toBe('3')
    expect(reviewBadgeLabel(120)).toBe('99+')
  })

  it('says when the agent is going ahead, and when it already has', () => {
    expect(goingAhead(review(), NOW)).toBeNull()
    const later = goingAhead(review({ going_ahead_at: '2026-11-01T17:00:00Z' }), NOW)
    expect(later?.passed).toBe(false)
    expect(later?.label).toMatch(/^Going ahead at .* unless you say no$/)
    const past = goingAhead(review({ going_ahead_at: '2026-11-01T11:00:00Z' }), NOW)
    expect(past).toEqual({ label: expect.stringMatching(/^Going ahead since /), passed: true })
    expect(goingAhead(review({ going_ahead_at: 'nonsense' }), NOW)).toBeNull()
  })
})

describe('submit state', () => {
  it('names what is missing until every item or the whole review is decided', () => {
    const r = review()
    expect(submitState(r, { items: {} })).toMatchObject({ ready: false, missing: 2 })
    expect(submitState(r, { items: {} }).message).toBe(
      'Decide 2 more items, or choose one decision for the whole review.',
    )
    expect(submitState(r, { items: { i1: { decision: 'approve' } } }).message).toMatch(/Decide 1 more item,/)
    expect(submitState(r, { items: { i1: { decision: 'approve' }, i2: { decision: 'reject' } } })).toMatchObject({
      ready: true,
      message: 'Ready to send.',
    })
  })

  it('lets a whole-review decision stand in, and says what it covers', () => {
    const state = submitState(review(), { items: { i1: { decision: 'reject' } }, overall: { decision: 'approve' } })
    expect(state.ready).toBe(true)
    expect(state.message).toBe('Approve covers the 1 undecided item.')
  })

  it('detects an unsent draft', () => {
    expect(draftHasContent({ items: {} })).toBe(false)
    expect(draftHasContent({ items: { i1: { feedback: '  ' } } })).toBe(false)
    expect(draftHasContent({ items: { i1: { feedback: 'Bigger CTA' } } })).toBe(true)
    expect(draftHasContent({ items: {}, overall: { note: 'ok' } } satisfies ReviewDraft)).toBe(true)
  })
})

describe('evidence chips', () => {
  it('labels files by name and size, images inline, urls by address', () => {
    expect(
      evidenceChip({
        id: 'e1',
        kind: 'file',
        title: null,
        caption: null,
        open_path: '/state/reviews/R-1/evidence/report.pdf',
        original_path: '/Users/me/report.pdf',
        snapshotted: true,
        url: null,
        content_type: 'application/pdf',
        size_bytes: 2_621_440,
      }),
    ).toMatchObject({ label: 'report.pdf', detail: '2.5 MB', isImage: false, path: '/state/reviews/R-1/evidence/report.pdf' })
    const image = evidenceChip({
      id: 'e2',
      kind: 'image',
      title: 'Hero B',
      caption: null,
      open_path: '/state/hero.png',
      original_path: null,
      snapshotted: true,
      url: null,
      content_type: 'image/png',
      size_bytes: 900,
    })
    expect(image).toMatchObject({ label: 'Hero B', isImage: true, detail: '900 B' })
    expect(
      evidenceChip({
        id: 'e3',
        kind: 'url',
        title: null,
        caption: null,
        open_path: null,
        original_path: null,
        snapshotted: false,
        url: 'https://example.com/design',
        content_type: null,
        size_bytes: null,
      }),
    ).toMatchObject({ label: 'https://example.com/design', path: null, isImage: false, detail: null })
    expect(formatBytes(null)).toBeNull()
  })

  it('flags a file that was too large to freeze', () => {
    const chip = evidenceChip({
      id: 'e4',
      kind: 'file',
      title: null,
      caption: null,
      open_path: '/Users/me/big.mov',
      original_path: '/Users/me/big.mov',
      snapshotted: false,
      url: null,
      content_type: 'video/quicktime',
      size_bytes: 40_000_000,
    })
    expect(chip.detail).toBe('38 MB · not frozen')
  })
})

describe('notifications', () => {
  const prefs = { enabled: true, notify_on_input_required: true }
  it('names the bot and the title, and carries the ask', () => {
    expect(reviewNotification(review(), prefs)).toEqual({
      title: 'Juno needs a decision: Pricing page',
      body: 'Ship the new hero?',
      key: 'review:R-1',
    })
    expect(reviewNotification(review({ bot: null, created_by: { name: 'Claude', context: { origin: 'mcp' } } }), prefs)?.title).toBe(
      'Claude needs a decision: Pricing page',
    )
  })
  it('follows the approvals-and-questions setting', () => {
    expect(reviewNotification(review(), { enabled: false, notify_on_input_required: true })).toBeNull()
    expect(reviewNotification(review(), { enabled: true, notify_on_input_required: false })).toBeNull()
  })
  it('does not announce the backlog at startup, only what arrives afterwards', () => {
    const first = newlyOpenReviews(null, [review({ id: 'R-1' }), review({ id: 'R-2' })])
    expect(first.fresh).toEqual([])
    const second = newlyOpenReviews(first.seen, [
      review({ id: 'R-1' }),
      review({ id: 'R-2' }),
      review({ id: 'R-3' }),
      review({ id: 'R-0', status: 'approved' }),
    ])
    expect(second.fresh.map((r) => r.id)).toEqual(['R-3'])
    expect(newlyOpenReviews(second.seen, [review({ id: 'R-3' })]).fresh).toEqual([])
  })
})

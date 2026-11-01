import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { DaemonApiClient, Review, ReviewDraft } from '@falcondeck/client-core'

import { newlyOpenReviews, openReviewCount } from '../review-inbox'
import { useControlStateEvents } from './useControlStateEvents'

type ReviewListApi = Pick<DaemonApiClient, 'listReviews'>

export type ReviewInbox = {
  reviews: Review[]
  openCount: number
  loading: boolean
  error: string | null
  refresh: () => Promise<void>
  /** Fold a review the daemon just returned (after respond or withdraw) into the list. */
  accept: (review: Review) => void
  /** What James has typed, kept here so leaving the view does not lose it. */
  drafts: Record<string, ReviewDraft>
  updateDraft: (id: string, change: (draft: ReviewDraft) => ReviewDraft) => void
  clearDraft: (id: string) => void
}

const EMPTY_DRAFT: ReviewDraft = { items: {} }

/**
 * The review inbox for the whole app: the list behind the sidebar badge, the
 * view, and "needs a decision" notifications. It refetches on the `reviews`
 * control event and when the window regains focus, and it reports reviews that
 * appeared after the first load (never the backlog at startup).
 */
export function useReviewInbox({
  api,
  baseUrl,
  enabled,
  onNewReviews,
}: {
  api: ReviewListApi | null
  baseUrl: string | null
  enabled: boolean
  onNewReviews?: (reviews: Review[]) => void
}): ReviewInbox {
  const [reviews, setReviews] = useState<Review[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, ReviewDraft>>({})
  const seenRef = useRef<Set<string> | null>(null)
  const requestRef = useRef(0)
  const onNewRef = useRef(onNewReviews)
  useEffect(() => {
    onNewRef.current = onNewReviews
  }, [onNewReviews])

  const load = useCallback(async () => {
    if (!api || !enabled) return
    const current = ++requestRef.current
    try {
      const rows = await api.listReviews({ include_closed: true })
      // A slower, older answer must not overwrite a newer one.
      if (requestRef.current !== current) return
      const { fresh, seen } = newlyOpenReviews(seenRef.current, rows)
      seenRef.current = seen
      setReviews(rows)
      setError(null)
      if (fresh.length > 0) onNewRef.current?.(fresh)
    } catch (loadError) {
      if (requestRef.current === current) {
        setError(loadError instanceof Error ? loadError.message : 'Reviews could not be loaded.')
      }
    } finally {
      if (requestRef.current === current) setLoading(false)
    }
  }, [api, enabled])

  // A different daemon, or the switch turning off, starts from nothing: ids
  // from one store mean nothing in another.
  useEffect(() => {
    seenRef.current = null
    requestRef.current++
    setReviews([])
    setError(null)
    if (!api || !enabled) {
      setLoading(false)
      return
    }
    setLoading(true)
    void load()
    return () => {
      // A counter, not a DOM node: bumping it is what invalidates in-flight reads.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      requestRef.current++
    }
  }, [api, enabled, load])

  useControlStateEvents(enabled ? baseUrl : null, (_revision, domains) => {
    if (domains.includes('reviews')) void load()
  })

  useEffect(() => {
    if (!enabled || !api) return
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [api, enabled, load])

  const accept = useCallback((review: Review) => {
    // Invalidate any in-flight list read that predates this answer.
    requestRef.current++
    setLoading(false)
    setReviews((rows) =>
      rows.some((row) => row.id === review.id)
        ? rows.map((row) => (row.id === review.id ? review : row))
        : [review, ...rows],
    )
  }, [])

  const updateDraft = useCallback(
    (id: string, change: (draft: ReviewDraft) => ReviewDraft) =>
      setDrafts((current) => ({ ...current, [id]: change(current[id] ?? EMPTY_DRAFT) })),
    [],
  )
  const clearDraft = useCallback(
    (id: string) =>
      setDrafts((current) => {
        if (!(id in current)) return current
        const rest = { ...current }
        delete rest[id]
        return rest
      }),
    [],
  )

  const openCount = useMemo(() => (enabled ? openReviewCount(reviews) : 0), [enabled, reviews])

  return {
    reviews,
    openCount,
    loading,
    error,
    refresh: load,
    accept,
    drafts,
    updateDraft,
    clearDraft,
  }
}

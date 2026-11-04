import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type {
  DaemonApiClient,
  MarkNotificationsReadRequest,
  NotificationCounts,
  NotificationFilter,
  NotificationRecord,
} from '@falcondeck/client-core'

import { useControlStateEvents } from './useControlStateEvents'

export type NotificationCentreApi = Pick<
  DaemonApiClient,
  'listNotifications' | 'getNotification' | 'markNotificationsRead'
>

export const NOTIFICATION_PAGE = 50
const MAX_PAGE = 200
/** Enough to catch what arrived while the list showed only "Needs you". */
const NOTICE_WATCH = 20
const EMPTY_COUNTS: NotificationCounts = { unread_count: 0, needs_you_count: 0, latest_seq: 0 }

export type NotificationCentre = {
  records: NotificationRecord[]
  counts: NotificationCounts
  filter: NotificationFilter
  setFilter: (filter: NotificationFilter) => void
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  error: string | null
  /** The daemon predates the centre, so the bell stays hidden. */
  unsupported: boolean
  refresh: () => Promise<void>
  loadMore: () => Promise<void>
  markRead: (id: string) => Promise<void>
  markAllRead: () => Promise<void>
}

function unavailable(error: unknown): boolean {
  return (error as { status?: number } | null)?.status === 404
}

/**
 * The notification centre for the whole app: the list behind the sidebar badge
 * and the view. The daemon owns the records, so a refresh re-reads what is on
 * screen from the head and replaces it. Merging into a loaded tail could leave
 * a gap below a backlog, or a row that missed a read from another device.
 */
export function useNotificationCentre({
  api,
  baseUrl,
  enabled,
  onNewNotices,
}: {
  api: NotificationCentreApi | null
  baseUrl: string | null
  enabled: boolean
  onNewNotices?: (notices: NotificationRecord[]) => void
}): NotificationCentre {
  const [records, setRecords] = useState<NotificationRecord[]>([])
  const [counts, setCounts] = useState(EMPTY_COUNTS)
  const [filter, setFilterState] = useState<NotificationFilter>('all')
  const [cursor, setCursor] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const keepError = useRef(false)
  const [unsupported, setUnsupported] = useState(false)

  const recordsRef = useRef(records)
  const countsRef = useRef(counts)
  const filterRef = useRef(filter)
  const cursorRef = useRef(cursor)
  /** Bumped when the list's meaning changes: another daemon, or another filter. */
  const listGeneration = useRef(0)
  /** Bumped only for another daemon: a read still counts across a filter change. */
  const hostGeneration = useRef(0)
  const mutationRevision = useRef(0)
  const mutationsInFlight = useRef(0)
  const walking = useRef(false)
  const loadingMoreRef = useRef(false)
  const refreshAgain = useRef(false)
  const noticeBaseline = useRef<number | null>(null)
  const onNewRef = useRef(onNewNotices)
  const loadRef = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    onNewRef.current = onNewNotices
  }, [onNewNotices])

  const showRecords = useCallback((next: NotificationRecord[]) => {
    recordsRef.current = next
    setRecords(next)
  }, [])
  const showCounts = useCallback((next: NotificationCounts) => {
    countsRef.current = next
    setCounts(next)
  }, [])
  const showCursor = useCallback((next: number | undefined) => {
    cursorRef.current = next
    setCursor(next)
  }, [])

  /** Only a head read moves `latest_seq`: anything else can report a record
   * James has not been shown, and mark-all would take it. */
  const adoptKeepingHead = useCallback(
    (next: NotificationCounts) => {
      showCounts({ ...next, latest_seq: countsRef.current.latest_seq })
    },
    [showCounts],
  )

  /** The first load seeds the baseline, so a launch does not replay history. */
  const revealNotices = useCallback((rows: readonly NotificationRecord[], latestSeq: number) => {
    const baseline = noticeBaseline.current
    noticeBaseline.current = Math.max(baseline ?? 0, latestSeq)
    if (baseline === null) return
    const fresh = rows.filter(
      (row) => row.kind === 'agent_notice' && row.seq > baseline && !row.read_at,
    )
    if (fresh.length > 0) onNewRef.current?.(fresh)
  }, [])

  const load = useCallback(async () => {
    if (!api || !enabled) return
    if (walking.current) {
      refreshAgain.current = true
      return
    }
    const generation = listGeneration.current
    const started = mutationRevision.current
    const wanted = filterRef.current
    const target = Math.max(NOTIFICATION_PAGE, recordsRef.current.length)
    const crossed = () => started !== mutationRevision.current || mutationsInFlight.current > 0
    walking.current = true
    try {
      const items: NotificationRecord[] = []
      const seen = new Set<string>()
      let next: number | undefined
      let head: NotificationCounts | null = null
      do {
        const page = await api.listNotifications({
          filter: wanted,
          limit: Math.min(MAX_PAGE, target - items.length),
          before_seq: next,
        })
        if (generation !== listGeneration.current) return
        // A page captured before a read must not make that record unread again.
        if (crossed()) {
          refreshAgain.current = true
          return
        }
        const fresh = page.items.filter((item) => {
          if (seen.has(item.id)) return false
          seen.add(item.id)
          return true
        })
        items.push(...fresh)
        next = page.next_before_seq ?? undefined
        if (!head) {
          // The first page's `latest_seq` matches the top of the list. A later
          // one could cover a record James was never shown.
          head = {
            unread_count: page.unread_count,
            needs_you_count: page.needs_you_count,
            latest_seq: page.latest_seq,
          }
          if (wanted === 'needs_you') {
            // That list holds no notices, so it cannot reveal one.
            const watch = await api.listNotifications({ filter: 'bots', limit: NOTICE_WATCH })
            if (generation !== listGeneration.current) return
            revealNotices(watch.items, watch.latest_seq)
          } else {
            revealNotices(page.items, page.latest_seq)
          }
        }
        if (fresh.length === 0) break
      } while (next !== undefined && items.length < target)
      showRecords(items)
      showCursor(next)
      if (head) showCounts(head)
      setUnsupported(false)
      // The refresh that follows a refused read must not wipe the reason.
      if (keepError.current) keepError.current = false
      else setError(null)
    } catch (loadError) {
      if (generation !== listGeneration.current) return
      if (unavailable(loadError)) {
        setUnsupported(true)
        showRecords([])
        showCounts(EMPTY_COUNTS)
        setError(null)
      } else {
        setError(loadError instanceof Error ? loadError.message : 'Notifications could not be loaded.')
      }
    } finally {
      if (generation === listGeneration.current) {
        walking.current = false
        setLoading(false)
        if (refreshAgain.current && mutationsInFlight.current === 0) {
          refreshAgain.current = false
          void loadRef.current()
        }
      }
    }
  }, [api, enabled, revealNotices, showCounts, showCursor, showRecords])

  useEffect(() => {
    loadRef.current = load
  }, [load])

  // Another daemon starts from nothing: ids from one store mean nothing in another.
  useEffect(() => {
    listGeneration.current++
    hostGeneration.current++
    walking.current = false
    refreshAgain.current = false
    mutationsInFlight.current = 0
    noticeBaseline.current = null
    loadingMoreRef.current = false
    setLoadingMore(false)
    showRecords([])
    showCounts(EMPTY_COUNTS)
    showCursor(undefined)
    setError(null)
    setUnsupported(false)
    if (!api || !enabled) {
      setLoading(false)
      return
    }
    setLoading(true)
    void load()
    return () => {
      listGeneration.current++
      hostGeneration.current++
    }
  }, [api, baseUrl, enabled, load, showCounts, showCursor, showRecords])

  useControlStateEvents(
    enabled ? baseUrl : null,
    (_revision, domains) => {
      if (domains.includes('notifications')) void load()
    },
    () => void load(),
  )

  useEffect(() => {
    if (!enabled || !api) return
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [api, enabled, load])

  const setFilter = useCallback(
    (next: NotificationFilter) => {
      if (next === filterRef.current) return
      filterRef.current = next
      setFilterState(next)
      listGeneration.current++
      walking.current = false
      refreshAgain.current = false
      loadingMoreRef.current = false
      setLoadingMore(false)
      showRecords([])
      showCursor(undefined)
      setLoading(true)
      void loadRef.current()
    },
    [showCursor, showRecords],
  )

  const loadMore = useCallback(async () => {
    const before = cursorRef.current
    if (!api || before === undefined || loadingMoreRef.current) return
    const generation = listGeneration.current
    const started = mutationRevision.current
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const page = await api.listNotifications({
        filter: filterRef.current,
        limit: NOTIFICATION_PAGE,
        before_seq: before,
      })
      if (generation !== listGeneration.current) return
      // A page that crossed a read or a refresh is stale. The next refresh or
      // press of the button asks again from the current cursor.
      if (started !== mutationRevision.current || before !== cursorRef.current) return
      const known = new Set(recordsRef.current.map((record) => record.id))
      showRecords([...recordsRef.current, ...page.items.filter((item) => !known.has(item.id))])
      showCursor(page.next_before_seq ?? undefined)
      adoptKeepingHead(page)
      setError(null)
    } catch (loadError) {
      if (generation === listGeneration.current) {
        setError(loadError instanceof Error ? loadError.message : 'Older notifications could not be loaded.')
      }
    } finally {
      if (generation === listGeneration.current) {
        loadingMoreRef.current = false
        setLoadingMore(false)
      }
    }
  }, [adoptKeepingHead, api, showCursor, showRecords])

  const mutate = useCallback(
    async (request: MarkNotificationsReadRequest, ids: ReadonlySet<string>, unread: number) => {
      if (!api) return
      const host = hostGeneration.current
      const before = recordsRef.current
      const previous = new Map(before.filter((row) => ids.has(row.id)).map((row) => [row.id, row]))
      const readAt = new Date().toISOString()
      showRecords(before.map((row) => (ids.has(row.id) ? { ...row, read_at: readAt } : row)))
      showCounts({ ...countsRef.current, unread_count: Math.max(0, countsRef.current.unread_count - unread) })
      mutationRevision.current++
      mutationsInFlight.current++
      const settle = () => {
        mutationRevision.current++
        mutationsInFlight.current--
        if (mutationsInFlight.current === 0 && refreshAgain.current) {
          refreshAgain.current = false
          void loadRef.current()
        }
      }
      try {
        const next = await api.markNotificationsRead(request)
        if (host !== hostGeneration.current) return
        // Answers can cross, so the last to arrive may hold the oldest counts.
        // A refresh after overlapping reads settles them.
        if (mutationsInFlight.current > 1) refreshAgain.current = true
        else adoptKeepingHead(next)
        settle()
      } catch (markError) {
        if (host !== hostGeneration.current) return
        showRecords(recordsRef.current.map((row) => previous.get(row.id) ?? row))
        showCounts({ ...countsRef.current, unread_count: countsRef.current.unread_count + unread })
        setError(markError instanceof Error ? markError.message : 'That could not be marked as read.')
        keepError.current = true
        refreshAgain.current = true
        settle()
      }
    },
    [adoptKeepingHead, api, showCounts, showRecords],
  )

  const markRead = useCallback(
    async (id: string) => {
      // A report opened from a banner can sit outside the list on screen.
      const row = recordsRef.current.find((record) => record.id === id)
      if (row?.read_at) return
      await mutate({ ids: [id] }, new Set([id]), row ? 1 : 0)
    },
    [mutate],
  )

  const markAllRead = useCallback(async () => {
    const { latest_seq: upTo, unread_count: unread } = countsRef.current
    if (unread === 0 || upTo === 0) return
    // Only what James could see: a record newer than this stays unread, and
    // so does one the filter is hiding. Those counts come back from the daemon.
    const ids = recordsRef.current.filter((row) => !row.read_at && row.seq <= upTo).map((row) => row.id)
    const filter = filterRef.current
    const everything = filter === 'all'
    await mutate(
      everything ? { up_to_seq: upTo } : { up_to_seq: upTo, filter },
      new Set(ids),
      everything ? unread : ids.length,
    )
  }, [mutate])

  return useMemo(
    () => ({
      records,
      counts,
      filter,
      setFilter,
      loading,
      loadingMore,
      hasMore: cursor !== undefined,
      error,
      unsupported,
      refresh: load,
      loadMore,
      markRead,
      markAllRead,
    }),
    [counts, cursor, error, filter, load, loadMore, loading, loadingMore, markAllRead, markRead, records, setFilter, unsupported],
  )
}

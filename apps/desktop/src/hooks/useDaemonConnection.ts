import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import {
  applyEventsToThreadDetail,
  applySnapshotEvent,
  createDaemonApiClient,
  mergeThreadDetailPage,
  THREAD_DETAIL_TAIL_LIMIT,
  reconcileSnapshotSelection,
  type DaemonSnapshot,
  type EventEnvelope,
  type RemoteStatusResponse,
  type ThreadDetail,
} from '@falcondeck/client-core'
import { realtimeAudioPlayer } from '@falcondeck/chat-ui'

import { activityTailStore } from '../activity-tails'
import { detectApiBaseUrl } from '../api'
import { CONNECTION_COPY } from '../connection-copy'
import { performanceTracingEnabled, recordPerformance } from '../performance'

type ConnectionState = 'connecting' | 'ready' | 'error'
const SELECTION_STORAGE_KEY = 'falcondeck.desktop.selection'
const DAEMON_BOOTSTRAP_RETRY_COUNT = 12
const DAEMON_BOOTSTRAP_RETRY_DELAY_MS = 500
const DAEMON_RECONNECT_BASE_DELAY_MS = 500
const DAEMON_RECONNECT_MAX_DELAY_MS = 10_000
// Only treat a connection as healthy (and reset backoff) after it stays open
// this long — mirrors the relay clients.
const DAEMON_BACKOFF_RESET_MS = 10_000
const DAEMON_SOCKET_CONNECT_TIMEOUT_MS = 10_000
const THREAD_PREFETCH_LIMIT = 3
const THREAD_PREFETCH_FALLBACK_DELAY_MS = 250
// A thread the client believes is live but that has gone this long without a
// single event is a candidate for a stuck spinner: re-check it against the
// daemon. A missed terminal thread-update strands the composer on Stop and the
// transcript on "Thinking…" until this fires, so the window is sized to what a
// user staring at a finished answer will tolerate, not to how long tool calls
// can run silently — a quiet-but-live thread just costs one cheap local
// snapshot fetch per interval until it speaks again.
const THREAD_STATUS_RECHECK_AFTER_MS = 10_000
const THREAD_STATUS_RECHECK_INTERVAL_MS = 5_000

type IdleWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
  cancelIdleCallback?: (handle: number) => void
}

function threadCacheKey(workspaceId: string, threadId: string) {
  return `${workspaceId}:${threadId}`
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export type DaemonConnectionOptions = {
  // Snapshots of remote host daemons (enrolled servers). They participate in
  // selection reconciliation so picking a remote workspace is not undone by
  // the local-snapshot reconcile pass, and their workspaces are excluded from
  // local thread-detail fetching (their details arrive over the relay).
  externalSnapshots?: (DaemonSnapshot | null)[]
}

export function useDaemonConnection(options: DaemonConnectionOptions = {}) {
  const { externalSnapshots } = options
  const initialSelection =
    typeof window === 'undefined'
      ? null
      : (() => {
          try {
            const raw = window.localStorage.getItem(SELECTION_STORAGE_KEY)
            return raw
              ? (JSON.parse(raw) as {
                  workspaceId: string | null
                  threadId: string | null
                  workspacePath?: string | null
                })
              : null
          } catch {
            return null
          }
        })()
  const [baseUrl, setBaseUrl] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting')
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(null)
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null)
  // A failed detail fetch used to be indistinguishable from an in-flight one,
  // so the conversation sat on "Loading…" forever with no way back.
  const [threadDetailError, setThreadDetailError] = useState<string | null>(null)
  const [threadDetailRetry, setThreadDetailRetry] = useState(0)
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatusResponse | null>(null)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(
    initialSelection?.workspaceId ?? null,
  )
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    initialSelection?.threadId ?? null,
  )
  const [gitRefreshTrigger, setGitRefreshTrigger] = useState(0)
  const threadDetailCacheRef = useRef(new Map<string, ThreadDetail>())
  const threadDetailPrefetchRef = useRef(new Set<string>())
  const pendingEventsRef = useRef<EventEnvelope[]>([])
  // When each thread last produced any event, used to spot threads that are
  // still painted as live long after the daemon stopped talking about them.
  const threadEventSeenAtRef = useRef(new Map<string, number>())
  const reconcilingStatusRef = useRef(false)
  const snapshotRef = useRef<DaemonSnapshot | null>(null)
  const eventFrameRef = useRef<number | null>(null)
  const eventTimerRef = useRef<number | null>(null)
  const reconnectAttemptRef = useRef(0)
  // Workspace ids are minted per daemon connect, so a daemon restart
  // invalidates the selected id even though it is the same project on disk.
  // The path is the stable identity used to re-map selection instead of
  // dumping the user into whatever thread reconcile falls back to.
  const selectedWorkspacePathRef = useRef<string | null>(
    initialSelection?.workspacePath ?? null,
  )

  const api = useMemo(() => (baseUrl ? createDaemonApiClient(baseUrl) : null), [baseUrl])

  const flushEvents = useCallback(() => {
    const startedAt = performanceTracingEnabled ? performance.now() : 0
    eventFrameRef.current = null
    eventTimerRef.current = null
    const events = pendingEventsRef.current
    if (events.length === 0) return
    pendingEventsRef.current = []

    // Activity buffers a short tail per visible thread straight off the wire,
    // rather than standing up a conversation model for each card.
    activityTailStore.ingest(events)

    // WebSocket frames can arrive much faster than the display can paint.
    // Applying one React update per frame made streaming cost scale with token
    // rate; one batch per animation frame preserves every protocol event while
    // limiting the UI to one render per paint.
    setSnapshot((current) => {
      let next = current
      for (const event of events) next = applySnapshotEvent(next, event)
      return next
    })
    setThreadDetail((c) => {
      const next = applyEventsToThreadDetail(c, events)
      if (next) {
        threadDetailCacheRef.current.set(
          threadCacheKey(next.workspace.id, next.thread.id),
          next,
        )
      }

      // Keep cached details for threads OTHER than the currently loaded one in
      // sync so switching threads renders fresh data from memory. The loaded
      // detail's cache entry was already written above from `next` — applying
      // the same event to it a second time would just burn allocations.
      const cacheEvents = new Map<string, EventEnvelope[]>()
      for (const event of events) {
        if (event.workspace_id && event.thread_id) {
          const cacheKey = threadCacheKey(event.workspace_id, event.thread_id)
          const isLoadedDetail =
            next !== null && threadCacheKey(next.workspace.id, next.thread.id) === cacheKey
          if (!isLoadedDetail) {
            const grouped = cacheEvents.get(cacheKey) ?? []
            grouped.push(event)
            cacheEvents.set(cacheKey, grouped)
          }
        }
      }
      for (const [cacheKey, groupedEvents] of cacheEvents) {
        const cached = threadDetailCacheRef.current.get(cacheKey)
        if (cached) {
          const updated = applyEventsToThreadDetail(cached, groupedEvents)
          if (updated && updated !== cached) {
            threadDetailCacheRef.current.set(cacheKey, updated)
          }
        }
      }

      return next
    })

    if (events.some((event) => event.event.type === 'turn-end')) {
      setGitRefreshTrigger((c) => c + 1)
    }
    recordPerformance('falcondeck:event-flush', startedAt, { eventCount: events.length })
  }, [])

  const clearPendingEvents = useCallback(() => {
    if (eventFrameRef.current !== null) {
      window.cancelAnimationFrame(eventFrameRef.current)
      eventFrameRef.current = null
    }
    if (eventTimerRef.current !== null) {
      window.clearTimeout(eventTimerRef.current)
      eventTimerRef.current = null
    }
    pendingEventsRef.current = []
  }, [])

  const handleEvent = useCallback((event: EventEnvelope) => {
    realtimeAudioPlayer.handleEvent(event)
    if (event.thread_id) {
      threadEventSeenAtRef.current.set(event.thread_id, Date.now())
    }
    pendingEventsRef.current.push(event)
    if (eventFrameRef.current !== null || eventTimerRef.current !== null) return
    // requestAnimationFrame can be suspended for a hidden webview. Continue
    // draining at a low rate in the background so a long-running turn cannot
    // accumulate an unbounded event queue while the app is minimised.
    if (document.visibilityState === 'hidden') {
      eventTimerRef.current = window.setTimeout(flushEvents, 50)
    } else {
      eventFrameRef.current = window.requestAnimationFrame(flushEvents)
    }
  }, [flushEvents])

  useEffect(() => clearPendingEvents, [clearPendingEvents])

  // Callers may merge an older page into the selected detail. Mirror every
  // committed detail back into the switch/prefetch cache so navigating away
  // and back cannot collapse the transcript to its former tail window.
  useEffect(() => {
    if (!threadDetail) return
    threadDetailCacheRef.current.set(
      threadCacheKey(threadDetail.workspace.id, threadDetail.thread.id),
      threadDetail,
    )
  }, [threadDetail])

  // Bootstrap daemon connection
  useEffect(() => {
    let socket: WebSocket | null = null
    let reconnectTimer: number | null = null
    let backoffResetTimer: number | null = null
    let connectTimeout: number | null = null
    let cancelled = false

    const teardownSocket = () => {
      if (backoffResetTimer !== null) {
        window.clearTimeout(backoffResetTimer)
        backoffResetTimer = null
      }
      if (connectTimeout !== null) {
        window.clearTimeout(connectTimeout)
        connectTimeout = null
      }
      if (!socket) return
      // Null out handlers before closing so onerror/onclose cannot double-fire
      // and schedule overlapping reconnects.
      socket.onopen = null
      socket.onmessage = null
      socket.onerror = null
      socket.onclose = null
      socket.close()
      socket = null
    }

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimer !== null) return
      const base = Math.min(
        DAEMON_RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttemptRef.current,
        DAEMON_RECONNECT_MAX_DELAY_MS,
      )
      reconnectAttemptRef.current += 1
      const jitteredDelay = Math.round(base * (0.8 + Math.random() * 0.4))
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null
        void connect()
      }, jitteredDelay)
    }

    async function connect() {
      let lastError: unknown = null

      for (let attempt = 0; attempt < DAEMON_BOOTSTRAP_RETRY_COUNT; attempt += 1) {
        const startedAt = performanceTracingEnabled ? performance.now() : 0
        try {
          const nextBaseUrl = await detectApiBaseUrl()
          if (cancelled) return
          setBaseUrl(nextBaseUrl)
          const nextApi = createDaemonApiClient(nextBaseUrl)
          const nextSnapshot = await nextApi.snapshot()
          if (cancelled) return
          // A frame-batched event from the socket that just died may still be
          // queued. It predates this authoritative reconnect snapshot and must
          // not land afterward, briefly rolling thread status or preferences
          // backward. The new event socket seeds itself with another snapshot.
          clearPendingEvents()
          setSnapshot(nextSnapshot)
          setConnectionError(null)
          setConnectionState('ready')
          recordPerformance('falcondeck:daemon-bootstrap', startedAt, { attempt: attempt + 1 })
          socket = nextApi.connectEvents(handleEvent)
          connectTimeout = window.setTimeout(() => {
            connectTimeout = null
            if (!cancelled && socket?.readyState === WebSocket.CONNECTING) {
              teardownSocket()
              setConnectionState('error')
              setConnectionError(CONNECTION_COPY.lostConnection)
              scheduleReconnect()
            }
          }, DAEMON_SOCKET_CONNECT_TIMEOUT_MS)
          socket.onopen = () => {
            if (cancelled) return
            if (connectTimeout !== null) {
              window.clearTimeout(connectTimeout)
              connectTimeout = null
            }
            // Resetting backoff immediately would defeat it when the daemon
            // drops connections right after accepting them; only reset once
            // the connection has stayed open for a while.
            backoffResetTimer = window.setTimeout(() => {
              backoffResetTimer = null
              reconnectAttemptRef.current = 0
            }, DAEMON_BACKOFF_RESET_MS)
          }
          socket.onclose = () => {
            if (cancelled) return
            teardownSocket()
            setConnectionState('error')
            setConnectionError(CONNECTION_COPY.lostConnection)
            scheduleReconnect()
          }
          socket.onerror = () => {
            if (cancelled) return
            teardownSocket()
            setConnectionState('error')
            setConnectionError(CONNECTION_COPY.lostConnection)
            scheduleReconnect()
          }
          return
        } catch (error) {
          lastError = error
          if (attempt < DAEMON_BOOTSTRAP_RETRY_COUNT - 1) {
            await delay(DAEMON_BOOTSTRAP_RETRY_DELAY_MS)
          }
        }
      }

      if (cancelled) return
      setConnectionState('error')
      setConnectionError(
        lastError instanceof Error ? lastError.message : CONNECTION_COPY.connectFailed,
      )
      scheduleReconnect()
    }

    void connect()
    return () => {
      cancelled = true
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer)
        reconnectTimer = null
      }
      teardownSocket()
    }
  }, [clearPendingEvents, handleEvent])

  const externalWorkspaceIds = useMemo(() => {
    const ids = new Set<string>()
    for (const external of externalSnapshots ?? []) {
      for (const workspace of external?.workspaces ?? []) {
        ids.add(workspace.id)
      }
    }
    return ids
  }, [externalSnapshots])

  const selectionSnapshot = useMemo(() => {
    const externals = (externalSnapshots ?? []).filter(
      (entry): entry is DaemonSnapshot => entry !== null,
    )
    if (externals.length === 0) return snapshot
    const base = snapshot ?? externals[0]
    if (!base) return snapshot
    return {
      ...base,
      workspaces: [
        ...(snapshot?.workspaces ?? []),
        ...externals.flatMap((entry) => entry.workspaces),
      ],
      threads: [...(snapshot?.threads ?? []), ...externals.flatMap((entry) => entry.threads)],
    }
  }, [externalSnapshots, snapshot])

  const selectedLocalWorkspaceStatus = useMemo(
    () =>
      snapshot?.workspaces.find((workspace) => workspace.id === selectedWorkspaceId)?.status ??
      null,
    [selectedWorkspaceId, snapshot?.workspaces],
  )

  // Reconcile selection when snapshot changes

  useEffect(() => {
    // Nothing to validate against yet; reconciling now would only wipe the
    // selection restored from storage before the first snapshot arrives.
    if (!selectionSnapshot) return
    const workspaces = selectionSnapshot.workspaces
    const selectedWorkspace = workspaces.find(
      (workspace) => workspace.id === selectedWorkspaceId,
    )
    if (selectedWorkspace) {
      selectedWorkspacePathRef.current = selectedWorkspace.path
    } else if (selectedWorkspacePathRef.current) {
      // The selected id is gone (or was already dropped) — typically a daemon
      // restart re-minting workspace ids while it restores workspaces. Follow
      // the project by path (local workspaces are listed first, so a same-path
      // remote cannot shadow the local one) and keep the thread selection:
      // restored thread ids are stable, and a new-thread draft (null) survives
      // via preserveEmptyThreadSelection below.
      const samePathWorkspace = workspaces.find(
        (workspace) => workspace.path === selectedWorkspacePathRef.current,
      )
      if (samePathWorkspace && samePathWorkspace.id !== selectedWorkspaceId) {
        setSelectedWorkspaceId(samePathWorkspace.id)
        return
      }
      if (!samePathWorkspace) {
        // The remembered project is not back yet (workspaces restore one by
        // one after a daemon restart). Hold rather than teleport the user
        // into whichever project happened to reconnect first; an explicit
        // sidebar click still changes selection at any time.
        return
      }
    }
    const nextSelection = reconcileSnapshotSelection(selectionSnapshot, selectedWorkspaceId, selectedThreadId, {
      preserveEmptyThreadSelection: true,
    })
    if (nextSelection.workspaceId !== selectedWorkspaceId) {
      setSelectedWorkspaceId(nextSelection.workspaceId)
    }
    if (nextSelection.threadId !== selectedThreadId) {
      setSelectedThreadId(nextSelection.threadId)
    }
  }, [selectionSnapshot, selectedThreadId, selectedWorkspaceId])
   

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SELECTION_STORAGE_KEY,
        JSON.stringify({
          workspaceId: selectedWorkspaceId,
          threadId: selectedThreadId,
          // The path survives daemon restarts (ids do not); it is what the
          // reconcile pass uses to re-find the same project.
          workspacePath: selectedWorkspacePathRef.current,
        }),
      )
    } catch {
      // Ignore storage failures and keep the in-memory selection authoritative.
    }
  }, [selectedThreadId, selectedWorkspaceId])

  // A detail error belongs to the selection that produced it. Do not let a
  // failed previous thread load turn the fresh-thread surface into an error
  // state when the user starts over or switches to another thread.
  useLayoutEffect(() => {
    setThreadDetailError(null)
  }, [selectedThreadId, selectedWorkspaceId])


  useLayoutEffect(() => {
    if (!selectedWorkspaceId || !selectedThreadId) {
      if (threadDetail !== null) {
        setThreadDetail(null)
      }
      return
    }

    // Remote-host thread details are loaded and kept fresh by the host
    // connection layer; do not fight it from the local cache.
    if (externalWorkspaceIds.has(selectedWorkspaceId)) {
      return
    }

    if (
      threadDetail &&
      threadDetail.workspace.id === selectedWorkspaceId &&
      threadDetail.thread.id === selectedThreadId
    ) {
      return
    }

    const cachedDetail =
      threadDetailCacheRef.current.get(threadCacheKey(selectedWorkspaceId, selectedThreadId)) ??
      null
    if (cachedDetail) {
      setThreadDetail(cachedDetail)
    } else if (threadDetail !== null) {
      setThreadDetail(null)
    }
  }, [externalWorkspaceIds, selectedThreadId, selectedWorkspaceId, threadDetail])
   

  // Fetch thread detail on selection change
   
  useEffect(() => {
    if (externalWorkspaceIds.has(selectedWorkspaceId ?? '')) {
      return
    }
    if (!api || !selectedWorkspaceId || !selectedThreadId) {
      setThreadDetail(null)
      return
    }

    const cacheKey = threadCacheKey(selectedWorkspaceId, selectedThreadId)
    // Startup restoration first publishes persisted thread summaries under a
    // Connecting workspace, before provider transcripts have been hydrated.
    // A detail fetched in that window is an empty placeholder whose timestamp
    // can equal the later hydrated summary, making it look cache-valid forever.
    // Drop that provisional value and fetch only after restoration settles.
    if (selectedLocalWorkspaceStatus === 'connecting') {
      threadDetailCacheRef.current.delete(cacheKey)
      setThreadDetail((current) =>
        current?.workspace.id === selectedWorkspaceId && current.thread.id === selectedThreadId
          ? null
          : current,
      )
      setThreadDetailError(null)
      return
    }
    const cachedDetail = threadDetailCacheRef.current.get(cacheKey) ?? null
    const selectedSummary =
      snapshot?.threads.find((thread) => thread.id === selectedThreadId) ?? null

    if (cachedDetail) {
      setThreadDetail(cachedDetail)
      if (!selectedSummary || cachedDetail.thread.updated_at === selectedSummary.updated_at) {
        return
      }
    }

    let cancelled = false
    setThreadDetailError(null)
    const startedAt = performanceTracingEnabled ? performance.now() : 0
    void api
      .threadDetail(selectedWorkspaceId, selectedThreadId, {
        mode: 'tail',
        limit: THREAD_DETAIL_TAIL_LIMIT,
      })
      .then((detail) => {
        if (cancelled) return
        setThreadDetail((current) => {
          const merged = mergeThreadDetailPage(current, detail, 'refresh')
          threadDetailCacheRef.current.set(cacheKey, merged)
          return merged
        })
        recordPerformance('falcondeck:thread-detail', startedAt, {
          cached: Boolean(cachedDetail),
          itemCount: detail.items.length,
        })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        if (!cachedDetail) setThreadDetail(null)
        setThreadDetailError(
          error instanceof Error ? error.message : 'Failed to load this conversation',
        )
    })
    return () => { cancelled = true }
  }, [
    api,
    externalWorkspaceIds,
    selectedThreadId,
    selectedWorkspaceId,
    selectedLocalWorkspaceStatus,
    snapshot?.threads,
    threadDetailRetry,
  ])
   

  // Prefetch only a few likely-next threads once startup/selection work is
  // idle. Fetching every workspace's current thread plus six recent threads
  // at once contended with the selected detail and made launch slower on
  // machines with fewer cores.
  useEffect(() => {
    if (!api || !snapshot || !selectedWorkspaceId) return
    if (selectedLocalWorkspaceStatus === 'connecting') return

    const targets = new Map<string, { workspaceId: string; threadId: string }>()
    const rememberTarget = (workspaceId: string | null | undefined, threadId: string | null | undefined) => {
      if (!workspaceId || !threadId) return
      targets.set(threadCacheKey(workspaceId, threadId), { workspaceId, threadId })
    }

    const hotThreads = snapshot.threads
      .filter(
        (thread) =>
          thread.workspace_id === selectedWorkspaceId &&
          thread.id !== selectedThreadId &&
          !thread.is_archived,
      )
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .slice(0, THREAD_PREFETCH_LIMIT)

    for (const thread of hotThreads) {
      rememberTarget(thread.workspace_id, thread.id)
    }

    const prefetch = () => {
      for (const [cacheKey, target] of targets) {
        if (threadDetailCacheRef.current.has(cacheKey) || threadDetailPrefetchRef.current.has(cacheKey)) {
          continue
        }

        threadDetailPrefetchRef.current.add(cacheKey)
        void api
          .threadDetail(target.workspaceId, target.threadId, {
            mode: 'tail',
            limit: THREAD_DETAIL_TAIL_LIMIT,
          })
          .then((detail) => {
            threadDetailCacheRef.current.set(cacheKey, detail)
          })
          .catch(() => {})
          .finally(() => {
            threadDetailPrefetchRef.current.delete(cacheKey)
          })
      }
    }

    const idleWindow = window as IdleWindow
    if (idleWindow.requestIdleCallback) {
      const handle = idleWindow.requestIdleCallback(prefetch, { timeout: 1_000 })
      return () => idleWindow.cancelIdleCallback?.(handle)
    }
    const handle = window.setTimeout(prefetch, THREAD_PREFETCH_FALLBACK_DELAY_MS)
    return () => window.clearTimeout(handle)
  }, [api, selectedLocalWorkspaceStatus, selectedThreadId, selectedWorkspaceId, snapshot])

  useEffect(() => {
    if (!snapshot) {
      threadDetailCacheRef.current.clear()
      threadDetailPrefetchRef.current.clear()
      threadEventSeenAtRef.current.clear()
      return
    }

    const validKeys = new Set(
      snapshot.threads.map((thread) => threadCacheKey(thread.workspace_id, thread.id)),
    )

    for (const key of threadDetailCacheRef.current.keys()) {
      if (!validKeys.has(key)) {
        threadDetailCacheRef.current.delete(key)
      }
    }

    for (const key of threadDetailPrefetchRef.current) {
      if (!validKeys.has(key)) {
        threadDetailPrefetchRef.current.delete(key)
      }
    }

    const validThreadIds = new Set(snapshot.threads.map((thread) => thread.id))
    for (const threadId of threadEventSeenAtRef.current.keys()) {
      if (!validThreadIds.has(threadId)) {
        threadEventSeenAtRef.current.delete(threadId)
      }
    }
  }, [snapshot])

  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  // Thread status is push-only: `running` is set by one event and cleared by
  // one event, and nothing downstream re-derives it. A terminal `thread-updated`
  // that is dropped, reordered behind a stale rebroadcast, or discarded by the
  // staleness guard therefore strands the thread as a permanently pulsing
  // sidebar entry with a "Thinking…" row and a Stop button, until the socket
  // happens to drop and the reconnect snapshot corrects it. Re-check quiet live
  // threads against the daemon so that state cannot outlive the turn.
  useEffect(() => {
    if (!api) return
    const interval = window.setInterval(() => {
      if (reconcilingStatusRef.current) return
      const threads = snapshotRef.current?.threads ?? []
      const now = Date.now()
      const suspect: string[] = []
      for (const thread of threads) {
        if (thread.status !== 'running' && thread.status !== 'waiting_for_input') continue
        const seenAt = threadEventSeenAtRef.current.get(thread.id)
        if (seenAt === undefined) {
          // First sighting (a bootstrap snapshot, or a thread that went live
          // before this hook mounted). Start its clock rather than treating an
          // absent entry as infinitely stale.
          threadEventSeenAtRef.current.set(thread.id, now)
          continue
        }
        if (now - seenAt >= THREAD_STATUS_RECHECK_AFTER_MS) suspect.push(thread.id)
      }
      if (suspect.length === 0) return

      reconcilingStatusRef.current = true
      void api
        .snapshot()
        .then((authoritative) => {
          const authoritativeById = new Map(
            authoritative.threads.map((thread) => [thread.id, thread] as const),
          )
          setSnapshot((current) => {
            if (!current) return current
            let changed = false
            const nextThreads = current.threads.map((thread) => {
              // Only suspect threads are touched, and only their status. The
              // rest of this summary — and every non-suspect thread — may
              // legitimately be newer than the fetch (events kept flowing while
              // it was in flight), and a wholesale replace would roll that back.
              if (!suspect.includes(thread.id)) return thread
              const correction = authoritativeById.get(thread.id)
              if (!correction || correction.status === thread.status) return thread
              changed = true
              return { ...thread, status: correction.status, last_error: correction.last_error }
            })
            return changed ? { ...current, threads: nextThreads } : current
          })
          // Whatever the daemon just told us is the fresh word on these threads;
          // don't re-fetch them again on the very next tick.
          const settledAt = Date.now()
          for (const id of suspect) threadEventSeenAtRef.current.set(id, settledAt)
        })
        .catch(() => {
          // A failed re-check is not worth surfacing: the next tick retries, and
          // a genuinely dead daemon is already reported by the socket.
        })
        .finally(() => {
          reconcilingStatusRef.current = false
        })
    }, THREAD_STATUS_RECHECK_INTERVAL_MS)
    return () => window.clearInterval(interval)
  }, [api])

  // Poll remote status
  useEffect(() => {
    if (!api) return
    let inFlight = false
    const refresh = () => {
      if (inFlight) return
      inFlight = true
      void api.remoteStatus().then(setRemoteStatus).catch((error) => {
        const message = error instanceof Error ? error.message : 'Failed to refresh remote status'
        setRemoteStatus((current) => current ? { ...current, last_error: message } : current)
      }).finally(() => {
        inFlight = false
      })
    }
    // The webview keeps timers running while minimised or hidden, and nothing
    // reads this poll's result until the window is visible again, so pause the
    // 2s loop while hidden. Becoming visible restarts it immediately (plus one
    // catch-up refresh rather than waiting a full interval).
    let interval: number | null = null
    const stopPolling = () => {
      if (interval === null) return
      window.clearInterval(interval)
      interval = null
    }
    const startPolling = () => {
      if (interval !== null) return
      interval = window.setInterval(refresh, 2_000)
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        stopPolling()
        return
      }
      startPolling()
      refresh()
    }
    refresh()
    if (document.visibilityState !== 'hidden') startPolling()
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      stopPolling()
    }
  }, [api])

  // Refresh git on workspace change
   
  useEffect(() => {
    if (selectedWorkspaceId) {
      setGitRefreshTrigger((c) => c + 1)
    }
  }, [selectedWorkspaceId])
   

  return {
    api,
    baseUrl,
    connectionState,
    connectionError,
    snapshot,
    setSnapshot,
    threadDetail,
    setThreadDetail,
    threadDetailError,
    retryThreadDetail: () => setThreadDetailRetry((current) => current + 1),
    remoteStatus,
    setRemoteStatus,
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    selectedThreadId,
    setSelectedThreadId,
    gitRefreshTrigger,
  }
}

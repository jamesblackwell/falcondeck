import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import {
  applyEventToThreadDetail,
  applySnapshotEvent,
  createDaemonApiClient,
  reconcileSnapshotSelection,
  type DaemonSnapshot,
  type EventEnvelope,
  type RemoteStatusResponse,
  type ThreadDetail,
} from '@falcondeck/client-core'

import { detectApiBaseUrl } from '../api'
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
const THREAD_PREFETCH_LIMIT = 3
const THREAD_PREFETCH_FALLBACK_DELAY_MS = 250

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
      let next = c
      for (const event of events) next = applyEventToThreadDetail(next, event)
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
      for (const event of events) {
        if (event.workspace_id && event.thread_id) {
          const cacheKey = threadCacheKey(event.workspace_id, event.thread_id)
          const isLoadedDetail =
            next !== null && threadCacheKey(next.workspace.id, next.thread.id) === cacheKey
          if (!isLoadedDetail) {
            const cached = threadDetailCacheRef.current.get(cacheKey)
            if (cached) {
              const updated = applyEventToThreadDetail(cached, event)
              if (updated && updated !== cached) {
                threadDetailCacheRef.current.set(cacheKey, updated)
              }
            }
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

  const handleEvent = useCallback((event: EventEnvelope) => {
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

  useEffect(() => () => {
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

  // Bootstrap daemon connection
  useEffect(() => {
    let socket: WebSocket | null = null
    let reconnectTimer: number | null = null
    let backoffResetTimer: number | null = null
    let cancelled = false

    const teardownSocket = () => {
      if (backoffResetTimer !== null) {
        window.clearTimeout(backoffResetTimer)
        backoffResetTimer = null
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
          const [nextSnapshot, nextRemoteStatus] = await Promise.all([
            nextApi.snapshot(),
            nextApi.remoteStatus(),
          ])
          if (cancelled) return
          setSnapshot(nextSnapshot)
          setRemoteStatus(nextRemoteStatus)
          setConnectionError(null)
          setConnectionState('ready')
          recordPerformance('falcondeck:daemon-bootstrap', startedAt, { attempt: attempt + 1 })
          socket = nextApi.connectEvents(handleEvent)
          socket.onopen = () => {
            if (cancelled) return
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
            setConnectionError('Lost connection to daemon')
            scheduleReconnect()
          }
          socket.onerror = () => {
            if (cancelled) return
            teardownSocket()
            setConnectionState('error')
            setConnectionError('Failed to connect to daemon events')
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
        lastError instanceof Error ? lastError.message : 'Failed to connect to daemon',
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
  }, [handleEvent])

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
      .threadDetail(selectedWorkspaceId, selectedThreadId)
      .then((detail) => {
        if (cancelled) return
        threadDetailCacheRef.current.set(cacheKey, detail)
        setThreadDetail(detail)
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
    snapshot?.threads,
    threadDetailRetry,
  ])
   

  // Prefetch only a few likely-next threads once startup/selection work is
  // idle. Fetching every workspace's current thread plus six recent threads
  // at once contended with the selected detail and made launch slower on
  // machines with fewer cores.
  useEffect(() => {
    if (!api || !snapshot || !selectedWorkspaceId) return

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
          .threadDetail(target.workspaceId, target.threadId)
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
  }, [api, selectedThreadId, selectedWorkspaceId, snapshot])

  useEffect(() => {
    if (!snapshot) {
      threadDetailCacheRef.current.clear()
      threadDetailPrefetchRef.current.clear()
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
  }, [snapshot])

  // Poll remote status
  useEffect(() => {
    if (!api || !remoteStatus || remoteStatus.status === 'inactive') return
    const interval = window.setInterval(() => {
      void api.remoteStatus().then(setRemoteStatus).catch((error) => {
        const message = error instanceof Error ? error.message : 'Failed to refresh remote status'
        setRemoteStatus((current) => current ? { ...current, last_error: message } : current)
      })
    }, 2000)
    return () => window.clearInterval(interval)
  }, [api, remoteStatus])

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

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

type ConnectionState = 'connecting' | 'ready' | 'error'
const SELECTION_STORAGE_KEY = 'falcondeck.desktop.selection'
const DAEMON_BOOTSTRAP_RETRY_COUNT = 12
const DAEMON_BOOTSTRAP_RETRY_DELAY_MS = 500

function threadCacheKey(workspaceId: string, threadId: string) {
  return `${workspaceId}:${threadId}`
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

export function useDaemonConnection() {
  const initialSelection =
    typeof window === 'undefined'
      ? null
      : (() => {
          try {
            const raw = window.localStorage.getItem(SELECTION_STORAGE_KEY)
            return raw ? (JSON.parse(raw) as { workspaceId: string | null; threadId: string | null }) : null
          } catch {
            return null
          }
        })()
  const [baseUrl, setBaseUrl] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting')
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(null)
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null)
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

  const api = useMemo(() => (baseUrl ? createDaemonApiClient(baseUrl) : null), [baseUrl])

  const handleEvent = useCallback((event: EventEnvelope) => {
    setSnapshot((c) => applySnapshotEvent(c, event))
    setThreadDetail((c) => {
      const next = applyEventToThreadDetail(c, event)
      if (next) {
        threadDetailCacheRef.current.set(
          threadCacheKey(next.workspace.id, next.thread.id),
          next,
        )
      }
      return next
    })

    if (event.workspace_id && event.thread_id) {
      const cacheKey = threadCacheKey(event.workspace_id, event.thread_id)
      const cached = threadDetailCacheRef.current.get(cacheKey)
      if (cached) {
        const next = applyEventToThreadDetail(cached, event)
        if (next) {
          threadDetailCacheRef.current.set(cacheKey, next)
        }
      }
    }

    if (event.event.type === 'turn-end') {
      setGitRefreshTrigger((c) => c + 1)
    }
  }, [])

  // Bootstrap daemon connection
  useEffect(() => {
    let socket: WebSocket | null = null
    let cancelled = false

    async function bootstrap() {
      let lastError: unknown = null

      for (let attempt = 0; attempt < DAEMON_BOOTSTRAP_RETRY_COUNT; attempt += 1) {
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
          socket = nextApi.connectEvents(handleEvent)
          socket.onclose = () => {
            if (cancelled) return
            setConnectionState('error')
            setConnectionError('Lost connection to daemon')
          }
          socket.onerror = () => {
            if (cancelled) return
            setConnectionState('error')
            setConnectionError('Failed to connect to daemon events')
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
    }

    void bootstrap()
    return () => {
      cancelled = true
      socket?.close()
    }
  }, [handleEvent])

  // Reconcile selection when snapshot changes
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    const nextSelection = reconcileSnapshotSelection(snapshot, selectedWorkspaceId, selectedThreadId, {
      preserveEmptyThreadSelection: true,
    })
    if (nextSelection.workspaceId !== selectedWorkspaceId) {
      setSelectedWorkspaceId(nextSelection.workspaceId)
    }
    if (nextSelection.threadId !== selectedThreadId) {
      setSelectedThreadId(nextSelection.threadId)
    }
  }, [snapshot, selectedThreadId, selectedWorkspaceId])
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    try {
      window.localStorage.setItem(
        SELECTION_STORAGE_KEY,
        JSON.stringify({
          workspaceId: selectedWorkspaceId,
          threadId: selectedThreadId,
        }),
      )
    } catch {
      // Ignore storage failures and keep the in-memory selection authoritative.
    }
  }, [selectedThreadId, selectedWorkspaceId])

  /* eslint-disable react-hooks/set-state-in-effect */
  useLayoutEffect(() => {
    if (!selectedWorkspaceId || !selectedThreadId) {
      if (threadDetail !== null) {
        setThreadDetail(null)
      }
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
  }, [selectedThreadId, selectedWorkspaceId, threadDetail])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Fetch thread detail on selection change
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
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
    void api
      .threadDetail(selectedWorkspaceId, selectedThreadId)
      .then((detail) => {
        if (cancelled) return
        threadDetailCacheRef.current.set(cacheKey, detail)
        setThreadDetail(detail)
      })
      .catch(() => {
        if (!cancelled && !cachedDetail) setThreadDetail(null)
    })
    return () => { cancelled = true }
  }, [api, selectedThreadId, selectedWorkspaceId, snapshot?.threads])
  /* eslint-enable react-hooks/set-state-in-effect */

  // Prefetch likely-next threads so switching can render from memory immediately.
  useEffect(() => {
    if (!api || !snapshot) return

    const targets = new Map<string, { workspaceId: string; threadId: string }>()
    const rememberTarget = (workspaceId: string | null | undefined, threadId: string | null | undefined) => {
      if (!workspaceId || !threadId) return
      targets.set(threadCacheKey(workspaceId, threadId), { workspaceId, threadId })
    }

    for (const workspace of snapshot.workspaces) {
      rememberTarget(workspace.id, workspace.current_thread_id)
    }

    if (selectedWorkspaceId) {
      const hotThreads = snapshot.threads
        .filter((thread) => thread.workspace_id === selectedWorkspaceId && !thread.is_archived)
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
        .slice(0, 6)

      for (const thread of hotThreads) {
        rememberTarget(thread.workspace_id, thread.id)
      }
    }

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
  }, [api, selectedWorkspaceId, snapshot])

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
      void api.remoteStatus().then(setRemoteStatus).catch(() => {})
    }, 2000)
    return () => window.clearInterval(interval)
  }, [api, remoteStatus])

  // Refresh git on workspace change
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (selectedWorkspaceId) {
      setGitRefreshTrigger((c) => c + 1)
    }
  }, [selectedWorkspaceId])
  /* eslint-enable react-hooks/set-state-in-effect */

  return {
    api,
    connectionState,
    connectionError,
    snapshot,
    setSnapshot,
    threadDetail,
    setThreadDetail,
    remoteStatus,
    setRemoteStatus,
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    selectedThreadId,
    setSelectedThreadId,
    gitRefreshTrigger,
  }
}

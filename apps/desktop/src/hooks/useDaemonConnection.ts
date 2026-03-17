import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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

function threadCacheKey(workspaceId: string, threadId: string) {
  return `${workspaceId}:${threadId}`
}

export function useDaemonConnection() {
  const [baseUrl, setBaseUrl] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting')
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(null)
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null)
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatusResponse | null>(null)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [gitRefreshTrigger, setGitRefreshTrigger] = useState(0)
  const threadDetailCacheRef = useRef(new Map<string, ThreadDetail>())
  const threadDetailPrefetchRef = useRef(new Set<string>())

  const api = useMemo(() => (baseUrl ? createDaemonApiClient(baseUrl) : null), [baseUrl])
  const selectedThreadCacheKey =
    selectedWorkspaceId && selectedThreadId
      ? threadCacheKey(selectedWorkspaceId, selectedThreadId)
      : null
  const selectedThreadDetail = useMemo(() => {
    if (!selectedThreadCacheKey) {
      return null
    }

    if (
      threadDetail &&
      threadDetail.workspace.id === selectedWorkspaceId &&
      threadDetail.thread.id === selectedThreadId
    ) {
      return threadDetail
    }

    return threadDetailCacheRef.current.get(selectedThreadCacheKey) ?? null
  }, [selectedThreadCacheKey, selectedThreadId, selectedWorkspaceId, threadDetail])

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
        setConnectionState('ready')
        socket = nextApi.connectEvents(handleEvent)
      } catch (error) {
        setConnectionState('error')
        setConnectionError(error instanceof Error ? error.message : 'Failed to connect to daemon')
      }
    }

    void bootstrap()
    return () => {
      cancelled = true
      socket?.close()
    }
  }, [handleEvent])

  // Reconcile selection when snapshot changes
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

  // Fetch thread detail on selection change
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

  // Poll remote status
  useEffect(() => {
    if (!api || !remoteStatus || remoteStatus.status === 'inactive') return
    const interval = window.setInterval(() => {
      void api.remoteStatus().then(setRemoteStatus).catch(() => {})
    }, 2000)
    return () => window.clearInterval(interval)
  }, [api, remoteStatus?.status])

  // Refresh git on workspace change
  useEffect(() => {
    if (selectedWorkspaceId) {
      setGitRefreshTrigger((c) => c + 1)
    }
  }, [selectedWorkspaceId])

  return {
    api,
    connectionState,
    connectionError,
    snapshot,
    setSnapshot,
    threadDetail: selectedThreadDetail,
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

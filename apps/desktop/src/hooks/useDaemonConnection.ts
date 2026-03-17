import { useCallback, useEffect, useMemo, useState } from 'react'

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

  const api = useMemo(() => (baseUrl ? createDaemonApiClient(baseUrl) : null), [baseUrl])

  const handleEvent = useCallback((event: EventEnvelope) => {
    setSnapshot((c) => applySnapshotEvent(c, event))
    setThreadDetail((c) => applyEventToThreadDetail(c, event))
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
    let cancelled = false
    void api
      .threadDetail(selectedWorkspaceId, selectedThreadId)
      .then((detail) => { if (!cancelled) setThreadDetail(detail) })
      .catch(() => { if (!cancelled) setThreadDetail(null) })
    return () => { cancelled = true }
  }, [api, selectedThreadId, selectedWorkspaceId])

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

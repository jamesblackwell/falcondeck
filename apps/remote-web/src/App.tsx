import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  applyEventToThreadDetail,
  applySnapshotEvent,
  base64ToBytes,
  bootstrapSessionCrypto,
  buildProjectGroups,
  bytesToBase64,
  conversationItemsForSelection,
  decryptJson,
  encryptJson,
  filesToImageInputs,
  generateBoxKeyPair,
  publicKeyToBase64,
  reconcileSnapshotSelection,
  restoreBoxKeyPair,
  secretKeyToBase64,
  shouldReusePersistedRemoteSession,
  upsertConversationItem,
  type ConversationItem,
  type DaemonSnapshot,
  type EncryptedEnvelope,
  type EventEnvelope,
  type ImageInput,
  type InteractiveResponsePayload,
  type MachinePresence,
  type PersistedRemoteSession,
  type QueuedRemoteAction,
  type RelayClientMessage,
  type RelayServerMessage,
  type RelayUpdate,
  type SessionCryptoState,
  type ThreadDetail,
  type ThreadHandle,
} from '@falcondeck/client-core'
import {
  Conversation,
  InteractiveRequestBar,
  PromptInput,
  SessionHeader,
  WorkspaceSidebar,
} from '@falcondeck/chat-ui'
import { Badge, Button, Input } from '@falcondeck/ui'

import { Lock, PanelLeft, Smartphone } from 'lucide-react'

// ── Helpers ──────────────────────────────────────────────────────────

function getDeviceLabel(): string {
  const ua = navigator.userAgent
  let browser = 'Browser'
  if (ua.includes('Firefox/')) browser = 'Firefox'
  else if (ua.includes('Edg/')) browser = 'Edge'
  else if (ua.includes('OPR/') || ua.includes('Opera')) browser = 'Opera'
  else if (ua.includes('Chrome/') && !ua.includes('Edg/')) browser = 'Chrome'
  else if (ua.includes('Safari/') && !ua.includes('Chrome/')) browser = 'Safari'

  let os = ''
  if (ua.includes('iPhone')) os = 'iPhone'
  else if (ua.includes('iPad')) os = 'iPad'
  else if (ua.includes('Android')) os = 'Android'
  else if (ua.includes('Mac OS')) os = 'macOS'
  else if (ua.includes('Windows')) os = 'Windows'
  else if (ua.includes('Linux')) os = 'Linux'

  return os ? `${browser} on ${os}` : browser
}

function parseDaemonEvent(payload: unknown): EventEnvelope | null {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'kind' in payload &&
    'event' in payload &&
    (payload as { kind?: string }).kind === 'daemon-event'
  ) {
    return (payload as { event: EventEnvelope }).event
  }
  return null
}

function encryptedRpcErrorMessage(payload: unknown) {
  if (typeof payload === 'object' && payload !== null && 'message' in payload) {
    const message = (payload as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return 'Remote action failed'
}

function reasoningOptions(
  snapshot: DaemonSnapshot | null,
  workspaceId: string | null,
  modelId: string | null,
) {
  const workspace = snapshot?.workspaces.find((e) => e.id === workspaceId)
  const model = workspace?.models.find((e) => e.id === modelId)
  const supported = model?.supported_reasoning_efforts.map((e) => e.reasoning_effort) ?? []
  if (supported.length > 0) return supported
  return model?.default_reasoning_effort ? [model.default_reasoning_effort] : ['medium']
}

function sendRelayMessage(socket: WebSocket, message: RelayClientMessage) {
  socket.send(JSON.stringify(message))
}

function connectionLabel(status: string) {
  if (status.startsWith('connected')) return 'Connected'
  if (status === 'connecting') return 'Connecting...'
  if (status === 'disconnected') return 'Disconnected'
  if (status.includes('claimed')) return 'Pairing...'
  return 'Not connected'
}

function applyDaemonEventsToSnapshot(
  current: DaemonSnapshot | null,
  events: EventEnvelope[],
) {
  let next = current
  for (const event of events) {
    next =
      applySnapshotEvent(next, event) ??
      (event.event.type === 'snapshot' ? event.event.snapshot : next)
  }
  return next
}

function applyDaemonEventsToThreadItems(
  current: Record<string, ConversationItem[]>,
  updatesByThread: Map<string, ConversationItem[]>,
) {
  let next = current

  for (const [threadId, updates] of updatesByThread) {
    let updated = current[threadId] ?? []
    for (const item of updates) {
      updated = upsertConversationItem(updated, item)
    }
    if (next === current) {
      next = { ...current }
    }
    next[threadId] = updated
  }

  return next
}

function applyDaemonEventsToThreadDetail(
  current: ThreadDetail | null,
  events: EventEnvelope[],
  updatesByThread: Map<string, ConversationItem[]>,
) {
  let next = current
  for (const event of events) {
    next = applyEventToThreadDetail(next, event)
  }
  if (!next) return next

  const threadUpdates = updatesByThread.get(next.thread.id)
  if (!threadUpdates || threadUpdates.length === 0) {
    return next
  }

  let items = next.items
  for (const item of threadUpdates) {
    items = upsertConversationItem(items, item)
  }

  return items === next.items ? next : { ...next, items }
}

function collectConversationItemUpdates(events: EventEnvelope[]) {
  const passthroughEvents: EventEnvelope[] = []
  const updatesByThread = new Map<string, Map<string, ConversationItem>>()

  for (const event of events) {
    if (
      event.thread_id &&
      (event.event.type === 'conversation-item-added' ||
        event.event.type === 'conversation-item-updated')
    ) {
      let threadUpdates = updatesByThread.get(event.thread_id)
      if (!threadUpdates) {
        threadUpdates = new Map<string, ConversationItem>()
        updatesByThread.set(event.thread_id, threadUpdates)
      }
      threadUpdates.set(
        `${event.event.item.kind}:${event.event.item.id}`,
        event.event.item,
      )
      continue
    }

    passthroughEvents.push(event)
  }

  return {
    passthroughEvents,
    updatesByThread: new Map(
      [...updatesByThread.entries()].map(([threadId, items]) => [
        threadId,
        [...items.values()],
      ]),
    ),
  }
}

// ── Session persistence ──────────────────────────────────────────────

const STORAGE_KEY = 'falcondeck.remote.session.v1'
const PENDING_ACTIONS_KEY = 'falcondeck.remote.pending-actions.v1'

function loadPersistedRemoteSession(): PersistedRemoteSession | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as PersistedRemoteSession
  } catch {
    return null
  }
}

function persistRemoteSession(value: PersistedRemoteSession | null) {
  if (value) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
  } else {
    window.localStorage.removeItem(STORAGE_KEY)
  }
}

function loadPendingActionIds() {
  try {
    const raw = window.localStorage.getItem(PENDING_ACTIONS_KEY)
    if (!raw) return [] as string[]
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

function persistPendingActionIds(actionIds: string[]) {
  if (actionIds.length === 0) {
    window.localStorage.removeItem(PENDING_ACTIONS_KEY)
    return
  }
  window.localStorage.setItem(PENDING_ACTIONS_KEY, JSON.stringify(actionIds))
}

function shouldDiscardPendingAction(error: unknown) {
  if (!(error instanceof Error)) return false
  return /failed with status 401|failed with status 404|queued action not found|invalid session token/i.test(
    error.message,
  )
}

// ── App ──────────────────────────────────────────────────────────────

export default function App() {
  const params = new URLSearchParams(window.location.search)
  const persistedSession = shouldReusePersistedRemoteSession(params, loadPersistedRemoteSession())
  const [relayUrl, setRelayUrl] = useState(
    params.get('relay') ??
      persistedSession?.relayUrl ??
      import.meta.env.VITE_FALCONDECK_RELAY_URL ??
      'https://connect.falcondeck.com',
  )
  const [pairingCode, setPairingCode] = useState(params.get('code') ?? persistedSession?.pairingCode ?? '')
  const [sessionId, setSessionId] = useState<string | null>(persistedSession?.sessionId ?? null)
  const [deviceId, setDeviceId] = useState<string | null>(persistedSession?.deviceId ?? null)
  const [clientToken, setClientToken] = useState<string | null>(persistedSession?.clientToken ?? null)
  const [connectionStatus, setConnectionStatus] = useState('not connected')
  const [machinePresence, setMachinePresence] = useState<MachinePresence | null>(null)
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(null)
  const [threadItems, setThreadItems] = useState<Record<string, ConversationItem[]>>({})
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<ImageInput[]>([])
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [selectedEffort, setSelectedEffort] = useState<string | null>('medium')
  const [selectedCollaborationMode, setSelectedCollaborationMode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [showProjects, setShowProjects] = useState(false)
  const selectionSeedRef = useRef<string | null>(null)
  const threadSettingsRequestRef = useRef(0)
  const reconnectTimerRef = useRef<number | null>(null)
  const reconnectAttemptRef = useRef(0)
  const [connectionGeneration, setConnectionGeneration] = useState(0)

  const requestCounter = useRef(1)
  const socketRef = useRef<WebSocket | null>(null)
  const sessionCryptoRef = useRef<SessionCryptoState | null>(null)
  const clientKeyPairRef = useRef<ReturnType<typeof generateBoxKeyPair> | null>(null)
  const pendingEncryptedUpdatesRef = useRef<RelayUpdate[]>([])
  const lastReceivedSeqRef = useRef(persistedSession?.lastReceivedSeq ?? 0)
  const pendingSessionPersistRef = useRef<Partial<PersistedRemoteSession> | null>(null)
  const sessionPersistTimerRef = useRef<number | null>(null)
  const pendingRelayUpdatesRef = useRef<RelayUpdate[]>([])
  const relayFlushFrameRef = useRef<number | null>(null)
  const relayFlushInProgressRef = useRef(false)
  const pendingRpc = useRef(
    new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: number }>(),
  )

  const isConnected = !!sessionId
  const relayConnected = connectionStatus.startsWith('connected')
  const hasSessionKey = !!sessionCryptoRef.current
  const isEncrypted = relayConnected && hasSessionKey

  const persistCurrentSession = useCallback(
    (overrides?: Partial<PersistedRemoteSession>) => {
      if (!sessionId || !clientToken || !deviceId || !clientKeyPairRef.current) return
      persistRemoteSession({
        relayUrl: relayUrl.trim(),
        pairingCode: pairingCode.trim(),
        sessionId,
        deviceId,
        clientToken,
        clientSecretKey: secretKeyToBase64(clientKeyPairRef.current),
        dataKey: sessionCryptoRef.current ? bytesToBase64(sessionCryptoRef.current.dataKey) : null,
        lastReceivedSeq: lastReceivedSeqRef.current,
        ...overrides,
      })
    },
    [clientToken, deviceId, pairingCode, relayUrl, sessionId],
  )

  const flushPersistedSession = useCallback(() => {
    if (sessionPersistTimerRef.current !== null) {
      window.clearTimeout(sessionPersistTimerRef.current)
      sessionPersistTimerRef.current = null
    }

    const pending = pendingSessionPersistRef.current
    pendingSessionPersistRef.current = null
    if (!pending) return

    persistCurrentSession(pending)
  }, [persistCurrentSession])

  const schedulePersistCurrentSession = useCallback(
    (
      overrides?: Partial<PersistedRemoteSession>,
      options?: {
        immediate?: boolean
      },
    ) => {
      pendingSessionPersistRef.current = {
        ...(pendingSessionPersistRef.current ?? {}),
        ...(overrides ?? {}),
      }

      if (options?.immediate) {
        flushPersistedSession()
        return
      }

      if (sessionPersistTimerRef.current !== null) {
        return
      }

      sessionPersistTimerRef.current = window.setTimeout(() => {
        flushPersistedSession()
      }, 400)
    },
    [flushPersistedSession],
  )

  useEffect(() => {
    if (persistedSession?.clientSecretKey) {
      try {
        clientKeyPairRef.current = restoreBoxKeyPair(persistedSession.clientSecretKey)
        if (persistedSession.dataKey) {
          sessionCryptoRef.current = {
            dataKey: base64ToBytes(persistedSession.dataKey),
            material: null,
          }
        }
      } catch {
        persistRemoteSession(null)
      }
    }
  }, [])

  useEffect(() => {
    if (!sessionId || !clientToken || !isEncrypted) return
    for (const actionId of loadPendingActionIds()) {
      void pollQueuedAction(actionId)
        .then(() => forgetPendingAction(actionId))
        .catch((queuedError) => {
          if (shouldDiscardPendingAction(queuedError)) {
            forgetPendingAction(actionId)
          }
        })
    }
  }, [clientToken, isEncrypted, sessionId])

  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current)
      }
      if (sessionPersistTimerRef.current !== null) {
        window.clearTimeout(sessionPersistTimerRef.current)
      }
      if (relayFlushFrameRef.current !== null) {
        window.cancelAnimationFrame(relayFlushFrameRef.current)
      }
    }
  }, [])

  useEffect(() => {
    const flushOnHide = () => {
      flushPersistedSession()
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushPersistedSession()
      }
    }

    window.addEventListener('pagehide', flushOnHide)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      window.removeEventListener('pagehide', flushOnHide)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [flushPersistedSession])

  useEffect(() => {
    const nextSelection = reconcileSnapshotSelection(snapshot, selectedWorkspaceId, selectedThreadId)
    if (nextSelection.workspaceId !== selectedWorkspaceId) {
      setSelectedWorkspaceId(nextSelection.workspaceId)
    }
    if (nextSelection.threadId !== selectedThreadId) {
      setSelectedThreadId(nextSelection.threadId)
    }
  }, [snapshot, selectedThreadId, selectedWorkspaceId])

  const relayWsUrl = useMemo(() => {
    const trimmed = relayUrl.trim().replace(/\/$/, '')
    if (trimmed.startsWith('https://')) return `wss://${trimmed.slice('https://'.length)}`
    if (trimmed.startsWith('http://')) return `ws://${trimmed.slice('http://'.length)}`
    return trimmed
  }, [relayUrl])

  const selectedWorkspace = useMemo(
    () => snapshot?.workspaces.find((w) => w.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, snapshot?.workspaces],
  )
  const selectedThread = useMemo(
    () => snapshot?.threads.find((t) => t.id === selectedThreadId) ?? null,
    [selectedThreadId, snapshot?.threads],
  )
  const groups = useMemo(
    () => buildProjectGroups(snapshot?.workspaces ?? [], snapshot?.threads ?? []),
    [snapshot?.threads, snapshot?.workspaces],
  )
  const interactiveRequests = useMemo(
    () =>
      (snapshot?.interactive_requests ?? []).filter(
        (request) => !selectedThreadId || request.thread_id === selectedThreadId,
      ),
    [selectedThreadId, snapshot?.interactive_requests],
  )
  const items = useMemo(
    () =>
      conversationItemsForSelection(
        selectedWorkspaceId,
        selectedThreadId,
        threadDetail,
        selectedThreadId ? threadItems[selectedThreadId] ?? [] : [],
      ),
    [selectedThreadId, selectedWorkspaceId, threadDetail, threadItems],
  )

  // ── WebSocket relay connection ─────────────────────────────────────

  useEffect(() => {
    if (!sessionId || !clientToken) return
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    const socket = new WebSocket(
      `${relayWsUrl}/v1/updates/ws?session_id=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(clientToken)}`,
    )
    let isCurrent = true
    socketRef.current = socket
    pendingEncryptedUpdatesRef.current = []
    pendingRelayUpdatesRef.current = []
    setConnectionStatus('connecting')
    setMachinePresence(null)
    setError(null)

    socket.onopen = () => {
      if (!isCurrent) return
      reconnectAttemptRef.current = 0
      setConnectionStatus('connected')
      sendRelayMessage(socket, { type: 'sync', after_seq: lastReceivedSeqRef.current })
    }

    socket.onmessage = (message) => {
      if (!isCurrent) return
      const payload = JSON.parse(message.data) as RelayServerMessage
      switch (payload.type) {
        case 'ready':
          setConnectionStatus(`connected as ${payload.role}`)
          break
        case 'sync':
          pendingRelayUpdatesRef.current.push(...payload.updates)
          scheduleRelayFlush()
          break
        case 'update':
          pendingRelayUpdatesRef.current.push(payload.update)
          scheduleRelayFlush()
          break
        case 'presence':
          setMachinePresence(payload.presence)
          break
        case 'action-updated':
          break
        case 'rpc-result':
          if (payload.request_id && pendingRpc.current.has(payload.request_id)) {
            void resolvePendingRpc(payload.request_id, payload.ok, payload.result ?? null, payload.error ?? null)
            return
          }
          if (!payload.ok) setError('Remote action failed')
          break
        case 'error':
          setError(payload.message)
          break
      }
    }

    socket.onclose = () => {
      if (!isCurrent) return
      setConnectionStatus('disconnected')
      setMachinePresence(null)
      for (const [reqId, pending] of pendingRpc.current.entries()) {
        window.clearTimeout(pending.timeout)
        pending.reject(new Error('Relay connection closed'))
        pendingRpc.current.delete(reqId)
      }
      pendingEncryptedUpdatesRef.current = []
      pendingRelayUpdatesRef.current = []
      if (relayFlushFrameRef.current !== null) {
        window.cancelAnimationFrame(relayFlushFrameRef.current)
        relayFlushFrameRef.current = null
      }
      if (sessionId && clientToken) {
        const delay = Math.min(1000 * 2 ** reconnectAttemptRef.current, 10_000)
        reconnectAttemptRef.current += 1
        reconnectTimerRef.current = window.setTimeout(() => {
          reconnectTimerRef.current = null
          setConnectionGeneration((value) => value + 1)
        }, delay)
      }
    }

    return () => {
      isCurrent = false
      socket.close()
    }
  }, [clientToken, connectionGeneration, relayWsUrl, sessionId])

  async function resolvePendingRpc(
    requestId: string,
    ok: boolean,
    result: EncryptedEnvelope | null,
    errorEnvelope: EncryptedEnvelope | null,
  ) {
    const pending = pendingRpc.current.get(requestId)
    if (!pending) return
    pendingRpc.current.delete(requestId)
    window.clearTimeout(pending.timeout)
    try {
      const sc = sessionCryptoRef.current
      if (!sc) throw new Error('Encrypted relay session is not ready')
      if (ok) {
        pending.resolve(result ? await decryptJson(sc.dataKey, result) : null)
        return
      }
      if (!errorEnvelope) { pending.reject(new Error('Remote action failed')); return }
      const dec = await decryptJson<unknown>(sc.dataKey, errorEnvelope)
      pending.reject(new Error(encryptedRpcErrorMessage(dec)))
    } catch (e) {
      pending.reject(e instanceof Error ? e : new Error('Remote action failed'))
    }
  }

  const flushRelayUpdates = useCallback(async () => {
    if (relayFlushInProgressRef.current) {
      return
    }

    relayFlushInProgressRef.current = true

    try {
      while (pendingRelayUpdatesRef.current.length > 0) {
        const batch = pendingRelayUpdatesRef.current.splice(0)
        const daemonEvents: EventEnvelope[] = []
        let nextPresence: MachinePresence | null | undefined
        let resetRemoteSession = false
        let shouldPersistCursor = false

        for (let index = 0; index < batch.length; index += 1) {
          const update = batch[index]
          lastReceivedSeqRef.current = Math.max(lastReceivedSeqRef.current, update.seq)

          if (update.body.t === 'session-bootstrap') {
            const kp = clientKeyPairRef.current
            if (!kp) {
              setError('Missing local pairing key material')
              continue
            }
            if (update.body.material.client_public_key !== publicKeyToBase64(kp)) {
              continue
            }
            try {
              sessionCryptoRef.current = bootstrapSessionCrypto(kp, update.body.material)
              setConnectionStatus('connected as client (encrypted)')
              schedulePersistCurrentSession(
                {
                  dataKey: bytesToBase64(sessionCryptoRef.current.dataKey),
                  lastReceivedSeq: lastReceivedSeqRef.current,
                },
                { immediate: true },
              )
              shouldPersistCursor = true

              if (pendingEncryptedUpdatesRef.current.length > 0) {
                batch.splice(index + 1, 0, ...pendingEncryptedUpdatesRef.current)
                pendingEncryptedUpdatesRef.current = []
              }
            } catch (e) {
              if (sessionPersistTimerRef.current !== null) {
                window.clearTimeout(sessionPersistTimerRef.current)
                sessionPersistTimerRef.current = null
              }
              pendingSessionPersistRef.current = null
              pendingEncryptedUpdatesRef.current = []
              pendingRelayUpdatesRef.current = []
              persistRemoteSession(null)
              persistPendingActionIds([])
              clientKeyPairRef.current = null
              sessionCryptoRef.current = null
              setSessionId(null)
              setDeviceId(null)
              setClientToken(null)
              setMachinePresence(null)
              setSnapshot(null)
              setThreadDetail(null)
              setThreadItems({})
              setConnectionGeneration((value) => value + 1)
              setError(
                e instanceof Error
                  ? e.message
                  : 'Failed to establish encrypted relay session',
              )
              resetRemoteSession = true
            }
            continue
          }

          if (update.body.t === 'presence') {
            nextPresence = update.body.presence
            shouldPersistCursor = true
            continue
          }

          if (update.body.t === 'action-status') {
            shouldPersistCursor = true
            continue
          }

          const sc = sessionCryptoRef.current
          if (!sc) {
            pendingEncryptedUpdatesRef.current.push(update)
            continue
          }

          let decrypted: unknown
          try {
            decrypted = await decryptJson(sc.dataKey, update.body.envelope)
          } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to decrypt relay update')
            continue
          }

          const event = parseDaemonEvent(decrypted)
          if (event) {
            shouldPersistCursor = true
            if (event.event.type !== 'text') {
              daemonEvents.push(event)
            }
          }
        }

        if (resetRemoteSession) {
          return
        }

        if (nextPresence !== undefined) {
          setMachinePresence(nextPresence)
        }

        if (shouldPersistCursor) {
          schedulePersistCurrentSession({
            lastReceivedSeq: lastReceivedSeqRef.current,
          })
        }

        if (daemonEvents.length > 0) {
          const { passthroughEvents, updatesByThread } =
            collectConversationItemUpdates(daemonEvents)
          setSnapshot((current) =>
            applyDaemonEventsToSnapshot(current, passthroughEvents),
          )
          if (updatesByThread.size > 0) {
            setThreadItems((current) =>
              applyDaemonEventsToThreadItems(current, updatesByThread),
            )
          }
          setThreadDetail((current) =>
            applyDaemonEventsToThreadDetail(
              current,
              passthroughEvents,
              updatesByThread,
            ),
          )
        }
      }
    } finally {
      relayFlushInProgressRef.current = false
      if (
        pendingRelayUpdatesRef.current.length > 0 &&
        relayFlushFrameRef.current === null
      ) {
        relayFlushFrameRef.current = window.requestAnimationFrame(() => {
          relayFlushFrameRef.current = null
          void flushRelayUpdates()
        })
      }
    }
  }, [schedulePersistCurrentSession])

  const scheduleRelayFlush = useCallback(() => {
    if (relayFlushFrameRef.current !== null) {
      return
    }

    relayFlushFrameRef.current = window.requestAnimationFrame(() => {
      relayFlushFrameRef.current = null
      void flushRelayUpdates()
    })
  }, [flushRelayUpdates])

  useEffect(() => {
    if (!selectedWorkspaceId || !selectedThreadId || !relayConnected || !hasSessionKey) {
      setThreadDetail(null)
      return
    }

    let cancelled = false
    void callRpc<ThreadDetail>('thread.detail', {
      workspace_id: selectedWorkspaceId,
      thread_id: selectedThreadId,
    })
      .then((detail) => {
        if (cancelled) return
        setThreadDetail(detail)
        setThreadItems((current) => {
          const bucket = current[selectedThreadId] ?? []
          const merged = detail.items.reduce((items, item) => upsertConversationItem(items, item), bucket)
          return { ...current, [selectedThreadId]: merged }
        })
        setError(null)
      })
      .catch((e) => {
        if (cancelled) return
        setThreadDetail(null)
        setError(e instanceof Error ? e.message : 'Failed to load thread detail')
      })

    return () => {
      cancelled = true
    }
  }, [hasSessionKey, relayConnected, selectedThreadId, selectedWorkspaceId])

  useEffect(() => {
    if (!relayConnected || !hasSessionKey || snapshot) return

    let cancelled = false
    void callRpc<DaemonSnapshot>('snapshot.current', {})
      .then((nextSnapshot) => {
        if (cancelled) return
        setSnapshot((current) => current ?? nextSnapshot)
        setError(null)
      })
      .catch((e) => {
        if (cancelled) return
        setError(e instanceof Error ? e.message : 'Failed to load remote snapshot')
      })

    return () => {
      cancelled = true
    }
  }, [hasSessionKey, relayConnected, snapshot])

  // ── Actions ────────────────────────────────────────────────────────

  async function handleClaimPairing() {
    const keyPair = generateBoxKeyPair()
    clientKeyPairRef.current = keyPair
    const response = await fetch(`${relayUrl.replace(/\/$/, '')}/v1/pairings/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairing_code: pairingCode.trim(),
        label: getDeviceLabel(),
        client_bundle: { encryption_variant: 'data_key_v1', public_key: publicKeyToBase64(keyPair) },
      }),
    })
    if (!response.ok) {
      clientKeyPairRef.current = null
      const payload = (await response.json().catch(() => null)) as { error?: string } | null
      setError(payload?.error ?? `Failed with status ${response.status}`)
      return
    }
    const claim = (await response.json()) as { session_id: string; device_id: string; client_token: string }
    setSessionId(claim.session_id)
    setDeviceId(claim.device_id)
    setClientToken(claim.client_token)
    lastReceivedSeqRef.current = 0
    setMachinePresence(null)
    setSnapshot(null)
    setThreadDetail(null)
    setThreadItems({})
    setConnectionStatus('claimed, awaiting encrypted session')
    setError(null)
    persistRemoteSession({
      relayUrl: relayUrl.trim(),
      pairingCode: pairingCode.trim(),
      sessionId: claim.session_id,
      deviceId: claim.device_id,
      clientToken: claim.client_token,
      clientSecretKey: secretKeyToBase64(keyPair),
      dataKey: null,
      lastReceivedSeq: 0,
    })
  }

  async function callRpc<T = unknown>(method: string, rpcParams: Record<string, unknown>) {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error('Remote connection is not ready')
    const sc = sessionCryptoRef.current
    if (!sc) throw new Error('Encrypted relay session is not ready')
    const requestId = `remote-${requestCounter.current++}`
    const encrypted = await encryptJson(sc.dataKey, rpcParams)
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingRpc.current.delete(requestId)
        reject(new Error(`Timed out waiting for ${method}`))
      }, 20_000)
      pendingRpc.current.set(requestId, { resolve: (v) => resolve(v as T), reject, timeout })
      sendRelayMessage(socket, { type: 'rpc-call', request_id: requestId, method, params: encrypted })
    })
  }

  async function pollQueuedAction<T = unknown>(actionId: string) {
    if (!sessionId || !clientToken) throw new Error('Remote session is not ready')
    for (;;) {
      const response = await fetch(
        `${relayUrl.replace(/\/$/, '')}/v1/sessions/${encodeURIComponent(sessionId)}/actions/${encodeURIComponent(actionId)}`,
        {
          headers: { authorization: `Bearer ${clientToken}` },
        },
      )
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null
        throw new Error(payload?.error ?? `Failed with status ${response.status}`)
      }
      const action = (await response.json()) as QueuedRemoteAction
      if (action.status === 'completed') {
        const sc = sessionCryptoRef.current
        if (!sc) return null as T
        return action.result ? await decryptJson<T>(sc.dataKey, action.result) : (null as T)
      }
      if (action.status === 'failed') {
        throw new Error(action.error ?? 'Remote action failed')
      }
      await new Promise((resolve) => window.setTimeout(resolve, 800))
    }
  }

  function rememberPendingAction(actionId: string) {
    const ids = new Set(loadPendingActionIds())
    ids.add(actionId)
    persistPendingActionIds([...ids])
  }

  function forgetPendingAction(actionId: string) {
    const ids = loadPendingActionIds().filter((value) => value !== actionId)
    persistPendingActionIds(ids)
  }

  async function submitQueuedAction<T = unknown>(
    actionType: string,
    rpcParams: Record<string, unknown>,
    options?: { awaitCompletion?: boolean },
  ) {
    if (!sessionId || !clientToken) throw new Error('Remote session is not ready')
    const sc = sessionCryptoRef.current
    if (!sc) throw new Error('Encrypted relay session is not ready')
    const encrypted = await encryptJson(sc.dataKey, rpcParams)
    const response = await fetch(
      `${relayUrl.replace(/\/$/, '')}/v1/sessions/${encodeURIComponent(sessionId)}/actions`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${clientToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          idempotency_key: crypto.randomUUID(),
          action_type: actionType,
          payload: encrypted,
        }),
      },
    )
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { error?: string } | null
      throw new Error(payload?.error ?? `Failed with status ${response.status}`)
    }
    const action = (await response.json()) as QueuedRemoteAction
    rememberPendingAction(action.action_id)
    if (options?.awaitCompletion === false) {
      void pollQueuedAction(action.action_id)
        .then(() => forgetPendingAction(action.action_id))
        .catch((queuedError) => {
          forgetPendingAction(action.action_id)
          setError(queuedError instanceof Error ? queuedError.message : 'Remote action failed')
        })
      return null as T
    }
    try {
      return await pollQueuedAction<T>(action.action_id)
    } finally {
      forgetPendingAction(action.action_id)
    }
  }

  async function handleSubmit() {
    if (!selectedWorkspace || !draft.trim()) return
    const submittedDraft = draft
    const submittedAttachments = attachments
    setDraft('')
    setAttachments([])
    setIsSubmitting(true)
    try {
      let activeThreadId = selectedThreadId
      if (!activeThreadId) {
        const handle = await submitQueuedAction<ThreadHandle>('thread.start', {
          workspace_id: selectedWorkspace.id,
          model_id: selectedModel,
          collaboration_mode_id: selectedCollaborationMode,
          approval_policy: 'on-request',
        })
        activeThreadId = handle.thread.id
        setSelectedWorkspaceId(handle.workspace.id)
        setSelectedThreadId(handle.thread.id)
      }
      await submitQueuedAction('turn.start', {
        workspace_id: selectedWorkspace.id,
        thread_id: activeThreadId,
        inputs: [{ type: 'text', text: submittedDraft }, ...submittedAttachments],
        model_id: selectedModel,
        reasoning_effort: selectedEffort,
        collaboration_mode_id: selectedCollaborationMode,
        approval_policy: 'on-request',
      }, { awaitCompletion: false })
      setError(null)
    } catch (e) {
      setDraft(submittedDraft)
      setAttachments(submittedAttachments)
      setError(e instanceof Error ? e.message : 'Remote action failed')
    } finally {
      setIsSubmitting(false)
    }
  }

  function handleInteractiveResponse(
    workspaceId: string,
    requestId: string,
    response: InteractiveResponsePayload,
  ) {
    void submitQueuedAction('interactive.respond', {
      workspace_id: workspaceId,
      request_id: requestId,
      response,
    }).catch((e) => setError(e instanceof Error ? e.message : 'Interactive response failed'))
  }

  // ── Sync model/effort/mode ─────────────────────────────────────────

  useEffect(() => {
    if (!selectedWorkspace) {
      setSelectedModel(null)
      setSelectedEffort('medium')
      setSelectedCollaborationMode(null)
      selectionSeedRef.current = null
      return
    }
    const seedKey = `${selectedWorkspace.id}:${selectedThread?.id ?? 'workspace'}`
    if (selectionSeedRef.current === seedKey) return
    selectionSeedRef.current = seedKey

    const fallbackModelId =
      selectedWorkspace.models.find((m) => m.is_default)?.id ?? selectedWorkspace.models[0]?.id ?? null
    if (selectedThread) {
      const nextModelId = selectedThread.codex.model_id ?? fallbackModelId
      setSelectedModel(nextModelId)
      setSelectedEffort(
        selectedThread.codex.reasoning_effort ??
          reasoningOptions(snapshot, selectedWorkspace.id, nextModelId)[0] ??
          'medium',
      )
      setSelectedCollaborationMode(selectedThread.codex.collaboration_mode_id ?? selectedWorkspace.collaboration_modes[0]?.id ?? null)
      return
    }
    setSelectedModel(fallbackModelId)
    setSelectedEffort(reasoningOptions(snapshot, selectedWorkspace.id, fallbackModelId)[0] ?? 'medium')
    setSelectedCollaborationMode(selectedWorkspace.collaboration_modes[0]?.id ?? null)
  }, [selectedThread, selectedWorkspace, snapshot])

  useEffect(() => {
    if (!selectedWorkspace) return
    const options = reasoningOptions(snapshot, selectedWorkspace.id, selectedModel)
    if (options.length === 0) return
    if (!selectedEffort || !options.includes(selectedEffort)) {
      setSelectedEffort(options[0] ?? 'medium')
    }
  }, [selectedEffort, selectedModel, selectedWorkspace, snapshot])

  const applyThreadHandle = useCallback((handle: ThreadHandle) => {
    setSnapshot((current) =>
      current
        ? {
            ...current,
            workspaces: current.workspaces.map((workspace) =>
              workspace.id === handle.workspace.id ? handle.workspace : workspace,
            ),
            threads: current.threads.map((thread) =>
              thread.id === handle.thread.id ? handle.thread : thread,
            ),
          }
        : current,
    )
    setThreadDetail((current) =>
      current && current.thread.id === handle.thread.id
        ? { ...current, workspace: handle.workspace, thread: handle.thread }
        : current,
    )
  }, [])

  const persistThreadSettings = useCallback(
    async ({
      modelId,
      effort,
      collaborationModeId,
    }: {
      modelId: string | null
      effort: string | null
      collaborationModeId: string | null
    }) => {
      if (!selectedWorkspace || !selectedThreadId) return
      const requestId = ++threadSettingsRequestRef.current
      try {
        const handle = await submitQueuedAction<ThreadHandle>('thread.update', {
          workspace_id: selectedWorkspace.id,
          thread_id: selectedThreadId,
          model_id: modelId,
          reasoning_effort: effort,
          collaboration_mode_id: collaborationModeId,
        })
        if (requestId !== threadSettingsRequestRef.current) return
        applyThreadHandle(handle)
        setError(null)
      } catch (e) {
        if (requestId !== threadSettingsRequestRef.current) return
        setError(e instanceof Error ? e.message : 'Remote action failed')
      }
    },
    [applyThreadHandle, selectedThreadId, selectedWorkspace],
  )

  const handleModelChange = useCallback(
    (modelId: string) => {
      setSelectedModel(modelId)
      const nextOptions = reasoningOptions(snapshot, selectedWorkspace?.id ?? null, modelId)
      const nextEffort =
        selectedEffort && nextOptions.includes(selectedEffort)
          ? selectedEffort
          : (nextOptions[0] ?? 'medium')
      setSelectedEffort(nextEffort)
      void persistThreadSettings({
        modelId,
        effort: nextEffort,
        collaborationModeId: selectedCollaborationMode,
      })
    },
    [
      persistThreadSettings,
      selectedCollaborationMode,
      selectedEffort,
      selectedWorkspace?.id,
      snapshot,
    ],
  )

  const handleEffortChange = useCallback(
    (effort: string) => {
      setSelectedEffort(effort)
      void persistThreadSettings({
        modelId: selectedModel,
        effort,
        collaborationModeId: selectedCollaborationMode,
      })
    },
    [persistThreadSettings, selectedCollaborationMode, selectedModel],
  )

  const handleCollaborationModeChange = useCallback(
    (modeId: string) => {
      setSelectedCollaborationMode(modeId)
      void persistThreadSettings({
        modelId: selectedModel,
        effort: selectedEffort,
        collaborationModeId: modeId,
      })
    },
    [persistThreadSettings, selectedEffort, selectedModel],
  )

  const handleSelectWorkspace = useCallback((workspaceId: string, threadId: string | null) => {
    setSelectedWorkspaceId(workspaceId)
    setSelectedThreadId(threadId)
    setShowProjects(false)
  }, [])

  const handleSelectThread = useCallback((workspaceId: string, threadId: string) => {
    setSelectedWorkspaceId(workspaceId)
    setSelectedThreadId(threadId)
    setShowProjects(false)
  }, [])

  const handleNewThread = useCallback((workspaceId: string) => {
    setSelectedWorkspaceId(workspaceId)
    setSelectedThreadId(null)
    setShowProjects(false)
  }, [])

  useEffect(() => {
    if (!snapshot) return
    const valid = new Set(snapshot.threads.map((t) => t.id))
    setThreadItems((current) => {
      const next = Object.entries(current).filter(([id]) => valid.has(id))
      return next.length === Object.keys(current).length ? current : Object.fromEntries(next)
    })
  }, [snapshot])

  // ── Pairing screen (not connected) ─────────────────────────────────

  if (!isConnected) {
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center bg-surface-0 p-6">
        <div className="w-full max-w-sm space-y-6">
          <div className="text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-surface-2">
              <Smartphone className="h-7 w-7 text-fg-tertiary" />
            </div>
            <h1 className="text-[length:var(--fd-text-xl)] font-semibold text-fg-primary">FalconDeck Remote</h1>
            <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-tertiary">
              Connect to your desktop session
            </p>
          </div>

          <div className="space-y-3">
            <Input
              value={relayUrl}
              onChange={(event) => setRelayUrl(event.target.value)}
              placeholder="Relay URL"
            />
            <Input
              value={pairingCode}
              onChange={(event) => setPairingCode(event.target.value.toUpperCase())}
              placeholder="Pairing code"
              className="text-center font-mono tracking-widest"
            />
            <Button
              type="button"
              disabled={!relayUrl.trim() || !pairingCode.trim()}
              onClick={() => void handleClaimPairing()}
              className="w-full"
            >
              Connect
            </Button>
          </div>

          <div className="flex items-center justify-center gap-2 text-[length:var(--fd-text-xs)] text-fg-muted">
            <Lock className="h-3 w-3" />
            End-to-end encrypted
          </div>

          {error ? (
            <p className="text-center text-[length:var(--fd-text-sm)] text-danger">{error}</p>
          ) : null}
        </div>
      </div>
    )
  }

  // ── Connected session ──────────────────────────────────────────────

  const desktopOnline = machinePresence?.daemon_connected ?? false

  return (
    <div className="flex h-[100dvh] flex-col overflow-x-hidden bg-surface-0">
      <SessionHeader
        workspace={selectedWorkspace}
        thread={selectedThread}
        className="border-b border-border-subtle pt-3 md:pt-10"
        navigation={
          <button
            type="button"
            onClick={() => setShowProjects((value) => !value)}
            className="flex shrink-0 items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1 text-fg-secondary transition-colors hover:bg-surface-2 hover:text-fg-primary"
            aria-label={showProjects ? 'Hide projects' : 'Show projects'}
          >
            <PanelLeft className="h-4 w-4" />
          </button>
        }
      >
        <div className="ml-auto flex items-center gap-2">
          <Badge
            variant={relayConnected ? 'success' : connectionStatus === 'disconnected' ? 'danger' : 'warning'}
            dot
          >
            {connectionLabel(connectionStatus)}
          </Badge>
          <Badge variant={desktopOnline ? 'success' : 'warning'} dot>
            {desktopOnline ? 'Desktop online' : 'Desktop retrying'}
          </Badge>
        </div>
      </SessionHeader>

      {showProjects ? (
        <div className="shrink-0 border-b border-border-subtle bg-surface-1">
          <WorkspaceSidebar
            groups={groups}
            selectedWorkspaceId={selectedWorkspaceId}
            selectedThreadId={selectedThreadId}
            onSelectWorkspace={handleSelectWorkspace}
            onSelectThread={handleSelectThread}
            onNewThread={handleNewThread}
            title="Projects"
            errors={error ? [error] : []}
            emptyState={{
              title: 'Waiting for projects',
              description: 'Projects will appear after the desktop shares its current snapshot.',
            }}
            className="h-[min(32rem,60dvh)] bg-surface-1"
            headerClassName="pt-4"
          />
        </div>
      ) : null}

      <InteractiveRequestBar
        requests={interactiveRequests}
        onRespond={(request, response) =>
          handleInteractiveResponse(request.workspace_id, request.request_id, response)
        }
      />

      <Conversation
        threadKey={
          selectedThreadId
            ? `${selectedWorkspaceId ?? 'workspace'}:${selectedThreadId}`
            : selectedWorkspaceId
        }
        items={items}
        isThinking={isSubmitting || selectedThread?.status === 'running'}
      />

      <div className="shrink-0">
        <PromptInput
          value={draft}
          onValueChange={setDraft}
          onSubmit={() => void handleSubmit()}
          onPickImages={(files) => void filesToImageInputs(files).then((n) => setAttachments((c) => [...c, ...n]))}
          attachments={attachments}
          models={selectedWorkspace?.models ?? []}
          selectedModelId={selectedModel}
          onModelChange={handleModelChange}
          reasoningOptions={reasoningOptions(snapshot, selectedWorkspaceId, selectedModel)}
          selectedEffort={selectedEffort}
          onEffortChange={handleEffortChange}
          collaborationModes={selectedWorkspace?.collaboration_modes ?? []}
          selectedCollaborationModeId={selectedCollaborationMode}
          onCollaborationModeChange={handleCollaborationModeChange}
          disabled={!selectedWorkspace || isSubmitting || !sessionId || !clientToken || !hasSessionKey}
          compact
        />
      </div>
    </div>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'

import {
  applySnapshotEvent,
  bootstrapSessionCrypto,
  buildProjectGroups,
  decryptJson,
  encryptJson,
  filesToImageInputs,
  generateBoxKeyPair,
  publicKeyToBase64,
  type ConversationItem,
  type DaemonSnapshot,
  type EncryptedEnvelope,
  type EventEnvelope,
  type ImageInput,
  type RelayClientMessage,
  type RelayServerMessage,
  type RelayUpdate,
  type SessionCryptoState,
  type ThreadHandle,
} from '@falcondeck/client-core'
import { Conversation, PromptInput } from '@falcondeck/chat-ui'
import { AppShell, Badge, StatusIndicator, Toolbar, ToolbarGroup } from '@falcondeck/ui'

import { PairingFlow } from './components/PairingFlow'
import { RemoteSidebar } from './components/Sidebar'
import { RemoteContextPanel } from './components/ContextPanel'

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

export default function App() {
  const params = new URLSearchParams(window.location.search)
  const [relayUrl, setRelayUrl] = useState(
    params.get('relay') ?? import.meta.env.VITE_FALCONDECK_RELAY_URL ?? 'https://connect.falcondeck.com',
  )
  const [pairingCode, setPairingCode] = useState(params.get('code') ?? '')
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [clientToken, setClientToken] = useState<string | null>(null)
  const [connectionStatus, setConnectionStatus] = useState('not connected')
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(null)
  const [threadItems, setThreadItems] = useState<Record<string, ConversationItem[]>>({})
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<ImageInput[]>([])
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [selectedEffort, setSelectedEffort] = useState<string | null>('medium')
  const [selectedCollaborationMode, setSelectedCollaborationMode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const requestCounter = useRef(1)
  const socketRef = useRef<WebSocket | null>(null)
  const sessionCryptoRef = useRef<SessionCryptoState | null>(null)
  const clientKeyPairRef = useRef<ReturnType<typeof generateBoxKeyPair> | null>(null)
  const pendingEncryptedUpdatesRef = useRef<RelayUpdate[]>([])
  const pendingRpc = useRef(
    new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timeout: number }>(),
  )

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
  const approvals = useMemo(
    () => (snapshot?.approvals ?? []).filter((a) => !selectedThreadId || a.thread_id === selectedThreadId),
    [selectedThreadId, snapshot?.approvals],
  )
  const items = useMemo(
    () => (selectedThreadId ? threadItems[selectedThreadId] ?? [] : []),
    [selectedThreadId, threadItems],
  )

  // WebSocket relay connection
  useEffect(() => {
    if (!sessionId || !clientToken) return
    const socket = new WebSocket(
      `${relayWsUrl}/v1/updates/ws?session_id=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(clientToken)}`,
    )
    let isCurrent = true
    socketRef.current = socket
    sessionCryptoRef.current = null
    pendingEncryptedUpdatesRef.current = []
    setConnectionStatus('connecting')
    setError(null)

    socket.onopen = () => {
      if (!isCurrent) return
      setConnectionStatus('connected')
      sendRelayMessage(socket, { type: 'sync', after_seq: 0 })
    }

    socket.onmessage = (message) => {
      if (!isCurrent) return
      const payload = JSON.parse(message.data) as RelayServerMessage
      switch (payload.type) {
        case 'ready':
          setConnectionStatus(`connected as ${payload.role}`)
          break
        case 'sync':
          void processRelayUpdates(payload.updates)
          break
        case 'update':
          void processRelayUpdate(payload.update)
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
      for (const [reqId, pending] of pendingRpc.current.entries()) {
        window.clearTimeout(pending.timeout)
        pending.reject(new Error('Relay connection closed'))
        pendingRpc.current.delete(reqId)
      }
      sessionCryptoRef.current = null
      pendingEncryptedUpdatesRef.current = []
    }

    return () => { isCurrent = false; socket.close() }
  }, [clientToken, relayWsUrl, sessionId])

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

  async function processRelayUpdates(updates: RelayUpdate[]) {
    for (const u of updates) await processRelayUpdate(u)
  }

  async function processRelayUpdate(update: RelayUpdate) {
    if (update.body.t === 'session-bootstrap') {
      const kp = clientKeyPairRef.current
      if (!kp) { setError('Missing local pairing key material'); return }
      try {
        sessionCryptoRef.current = bootstrapSessionCrypto(kp, update.body.material)
        setConnectionStatus('connected as client (encrypted)')
        const pending = pendingEncryptedUpdatesRef.current
        pendingEncryptedUpdatesRef.current = []
        await processRelayUpdates(pending)
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to establish encrypted relay session')
      }
      return
    }

    const sc = sessionCryptoRef.current
    if (!sc) { pendingEncryptedUpdatesRef.current.push(update); return }

    let decrypted: unknown
    try {
      decrypted = await decryptJson(sc.dataKey, update.body.envelope)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to decrypt relay update')
      return
    }

    const event = parseDaemonEvent(decrypted)
    if (!event) return

    setSnapshot((current) => {
      const next = applySnapshotEvent(current, event) ?? (event.event.type === 'snapshot' ? event.event.snapshot : current)
      if (next) {
        setSelectedWorkspaceId((x) => x ?? next.workspaces[0]?.id ?? null)
        setSelectedThreadId((x) => x ?? next.threads[0]?.id ?? null)
      }
      return next
    })

    if (!event.thread_id) return
    const de = event.event
    if (de.type === 'conversation-item-added' || de.type === 'conversation-item-updated') {
      setThreadItems((current) => {
        const bucket = current[event.thread_id!] ?? []
        const idx = bucket.findIndex((i) => i.id === de.item.id && i.kind === de.item.kind)
        const next = bucket.slice()
        if (idx === -1) next.push(de.item)
        else next[idx] = de.item
        next.sort((a, b) => a.created_at.localeCompare(b.created_at))
        return { ...current, [event.thread_id!]: next }
      })
    }
  }

  async function handleClaimPairing() {
    const keyPair = generateBoxKeyPair()
    clientKeyPairRef.current = keyPair
    const response = await fetch(`${relayUrl.replace(/\/$/, '')}/v1/pairings/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pairing_code: pairingCode.trim(),
        label: 'FalconDeck Remote Web',
        client_bundle: { encryption_variant: 'data_key_v1', public_key: publicKeyToBase64(keyPair) },
      }),
    })
    if (!response.ok) {
      clientKeyPairRef.current = null
      const payload = (await response.json().catch(() => null)) as { error?: string } | null
      setError(payload?.error ?? `Failed with status ${response.status}`)
      return
    }
    const claim = (await response.json()) as { session_id: string; client_token: string }
    setSessionId(claim.session_id)
    setClientToken(claim.client_token)
    setConnectionStatus('claimed, awaiting encrypted session')
    setError(null)
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

  async function handleSubmit() {
    if (!selectedWorkspace || !draft.trim()) return
    setIsSubmitting(true)
    try {
      let activeThreadId = selectedThreadId
      if (!activeThreadId) {
        const handle = await callRpc<ThreadHandle>('thread.start', {
          workspace_id: selectedWorkspace.id,
          model_id: selectedModel,
          collaboration_mode_id: selectedCollaborationMode,
          approval_policy: 'on-request',
        })
        activeThreadId = handle.thread.id
        setSelectedWorkspaceId(handle.workspace.id)
        setSelectedThreadId(handle.thread.id)
      }
      await callRpc('turn.start', {
        workspace_id: selectedWorkspace.id,
        thread_id: activeThreadId,
        inputs: [{ type: 'text', text: draft }, ...attachments],
        model_id: selectedModel,
        reasoning_effort: selectedEffort,
        collaboration_mode_id: selectedCollaborationMode,
        approval_policy: 'on-request',
      })
      setDraft('')
      setAttachments([])
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Remote action failed')
    } finally {
      setIsSubmitting(false)
    }
  }

  function handleApproval(requestId: string, decision: 'allow' | 'deny') {
    if (!selectedWorkspace) return
    void callRpc('approval.respond', {
      workspace_id: selectedWorkspace.id,
      request_id: requestId,
      decision,
    }).catch((e) => setError(e instanceof Error ? e.message : 'Approval action failed'))
  }

  // Sync model/effort/mode from thread/workspace
  useEffect(() => {
    if (!selectedWorkspace) { setSelectedModel(null); setSelectedEffort('medium'); setSelectedCollaborationMode(null); return }
    if (selectedThread) {
      setSelectedModel(selectedThread.codex.model_id ?? selectedWorkspace.models.find((m) => m.is_default)?.id ?? null)
      setSelectedEffort(selectedThread.codex.reasoning_effort ?? reasoningOptions(snapshot, selectedWorkspace.id, selectedThread.codex.model_id ?? selectedModel)[0] ?? 'medium')
      setSelectedCollaborationMode(selectedThread.codex.collaboration_mode_id ?? selectedWorkspace.collaboration_modes[0]?.id ?? null)
      return
    }
    setSelectedModel(selectedWorkspace.models.find((m) => m.is_default)?.id ?? null)
    setSelectedEffort(reasoningOptions(snapshot, selectedWorkspace.id, selectedWorkspace.models.find((m) => m.is_default)?.id ?? null)[0] ?? 'medium')
    setSelectedCollaborationMode(selectedWorkspace.collaboration_modes[0]?.id ?? null)
  }, [selectedThread, selectedWorkspace, snapshot, selectedModel])

  // Clean stale thread items
  useEffect(() => {
    if (!snapshot) return
    const valid = new Set(snapshot.threads.map((t) => t.id))
    setThreadItems((current) => {
      const next = Object.entries(current).filter(([id]) => valid.has(id))
      return next.length === Object.keys(current).length ? current : Object.fromEntries(next)
    })
  }, [snapshot])

  const pathLabel = selectedWorkspace?.path.split('/').pop()

  return (
    <AppShell
      sidebar={
        <RemoteSidebar
          groups={groups}
          selectedWorkspaceId={selectedWorkspaceId}
          selectedThreadId={selectedThreadId}
          onSelectWorkspace={(wId, tId) => { setSelectedWorkspaceId(wId); setSelectedThreadId(tId) }}
          onSelectThread={(wId, tId) => { setSelectedWorkspaceId(wId); setSelectedThreadId(tId) }}
          headerContent={
            <PairingFlow
              relayUrl={relayUrl}
              onRelayUrlChange={setRelayUrl}
              pairingCode={pairingCode}
              onPairingCodeChange={setPairingCode}
              onConnect={() => void handleClaimPairing()}
              connectionStatus={connectionStatus}
              isConnected={!!sessionId}
              error={error}
            />
          }
          error={null}
        />
      }
      main={
        <section className="flex min-h-[calc(100vh-24px)] flex-col overflow-hidden rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1">
          <Toolbar className="rounded-t-[var(--fd-radius-xl)]">
            <div className="flex items-center gap-2">
              <StatusIndicator
                status={connectionStatus.includes('connected') ? 'connected' : 'active'}
                size="md"
              />
              <div>
                <p className="text-[length:var(--fd-text-2xs)] uppercase tracking-[0.12em] text-fg-muted">
                  {pathLabel ?? 'Session'}
                </p>
                <p className="text-[length:var(--fd-text-md)] font-semibold text-fg-primary">
                  {selectedThread?.title ?? 'Waiting for daemon snapshot'}
                </p>
              </div>
            </div>
            <ToolbarGroup align="end">
              <Badge variant={connectionStatus.includes('connected') ? 'success' : 'warning'} dot>
                {connectionStatus}
              </Badge>
            </ToolbarGroup>
          </Toolbar>

          <Conversation items={items} />

          <PromptInput
            value={draft}
            onValueChange={setDraft}
            onSubmit={() => void handleSubmit()}
            onPickImages={(files) => void filesToImageInputs(files).then((n) => setAttachments((c) => [...c, ...n]))}
            attachments={attachments}
            models={selectedWorkspace?.models ?? []}
            selectedModelId={selectedModel}
            onModelChange={setSelectedModel}
            reasoningOptions={reasoningOptions(snapshot, selectedWorkspaceId, selectedModel)}
            selectedEffort={selectedEffort}
            onEffortChange={setSelectedEffort}
            collaborationModes={selectedWorkspace?.collaboration_modes ?? []}
            selectedCollaborationModeId={selectedCollaborationMode}
            onCollaborationModeChange={setSelectedCollaborationMode}
            approvalPolicy="on-request"
            disabled={!selectedWorkspace || isSubmitting || connectionStatus === 'connecting'}
            compact
          />
        </section>
      }
      rail={
        <RemoteContextPanel
          approvals={approvals}
          onApproval={handleApproval}
          thread={selectedThread}
        />
      }
    />
  )
}

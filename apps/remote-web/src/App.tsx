import { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Smartphone } from 'lucide-react'

import {
  bootstrapSessionCrypto,
  buildProjectGroups,
  decryptJson,
  encryptJson,
  type ConversationItem,
  type DaemonSnapshot,
  type EncryptedEnvelope,
  type EventEnvelope,
  type ImageInput,
  generateBoxKeyPair,
  projectLabel,
  publicKeyToBase64,
  type RelayClientMessage,
  type RelayServerMessage,
  type RelayUpdate,
  type SessionCryptoState,
  type ThreadHandle,
} from '@falcondeck/client-core'
import { Conversation, PromptInput } from '@falcondeck/chat-ui'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  ScrollArea,
} from '@falcondeck/ui'

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

function applySnapshotEvent(snapshot: DaemonSnapshot | null, event: EventEnvelope) {
  const daemonEvent = event.event
  if (daemonEvent.type === 'snapshot') {
    return daemonEvent.snapshot
  }
  if (!snapshot) return snapshot
  switch (daemonEvent.type) {
    case 'thread-started':
      return {
        ...snapshot,
        workspaces: snapshot.workspaces.map((workspace) =>
          workspace.id === daemonEvent.thread.workspace_id
            ? { ...workspace, current_thread_id: daemonEvent.thread.id, updated_at: daemonEvent.thread.updated_at }
            : workspace,
        ),
        threads: [daemonEvent.thread, ...snapshot.threads.filter((thread) => thread.id !== daemonEvent.thread.id)],
      }
    case 'thread-updated':
      return {
        ...snapshot,
        threads: snapshot.threads.map((thread) => (thread.id === daemonEvent.thread.id ? daemonEvent.thread : thread)),
      }
    case 'approval-request':
      return {
        ...snapshot,
        approvals: [daemonEvent.request, ...snapshot.approvals],
      }
    default:
      return snapshot
  }
}

function reasoningOptions(snapshot: DaemonSnapshot | null, workspaceId: string | null, modelId: string | null) {
  const workspace = snapshot?.workspaces.find((entry) => entry.id === workspaceId)
  const model = workspace?.models.find((entry) => entry.id === modelId)
  const supported = model?.supported_reasoning_efforts.map((entry) => entry.reasoning_effort) ?? []
  if (supported.length > 0) return supported
  return model?.default_reasoning_effort ? [model.default_reasoning_effort] : ['medium']
}

async function filesToImageInputs(files: FileList | null) {
  if (!files) return []
  const images = Array.from(files).filter((file) => file.type.startsWith('image/'))
  return Promise.all(
    images.map(
      (file) =>
        new Promise<ImageInput>((resolve, reject) => {
          const reader = new FileReader()
          reader.onerror = () => reject(reader.error)
          reader.onload = () =>
            resolve({
              type: 'image',
              id: crypto.randomUUID(),
              name: file.name,
              mime_type: file.type,
              url: String(reader.result),
            })
          reader.readAsDataURL(file)
        }),
    ),
  )
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
    new Map<
      string,
      {
        resolve: (value: unknown) => void
        reject: (error: Error) => void
        timeout: number
      }
    >(),
  )

  const relayWsUrl = useMemo(() => {
    const trimmed = relayUrl.trim().replace(/\/$/, '')
    if (trimmed.startsWith('https://')) return `wss://${trimmed.slice('https://'.length)}`
    if (trimmed.startsWith('http://')) return `ws://${trimmed.slice('http://'.length)}`
    return trimmed
  }, [relayUrl])

  const selectedWorkspace = useMemo(
    () => snapshot?.workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, snapshot?.workspaces],
  )
  const selectedThread = useMemo(
    () => snapshot?.threads.find((thread) => thread.id === selectedThreadId) ?? null,
    [selectedThreadId, snapshot?.threads],
  )
  const groups = useMemo(
    () => buildProjectGroups(snapshot?.workspaces ?? [], snapshot?.threads ?? []),
    [snapshot?.threads, snapshot?.workspaces],
  )
  const approvals = useMemo(
    () => (snapshot?.approvals ?? []).filter((approval) => !selectedThreadId || approval.thread_id === selectedThreadId),
    [selectedThreadId, snapshot?.approvals],
  )
  const items = useMemo(() => (selectedThreadId ? threadItems[selectedThreadId] ?? [] : []), [selectedThreadId, threadItems])

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
      for (const [requestId, pending] of pendingRpc.current.entries()) {
        window.clearTimeout(pending.timeout)
        pending.reject(new Error('Relay connection closed'))
        pendingRpc.current.delete(requestId)
      }
      sessionCryptoRef.current = null
      pendingEncryptedUpdatesRef.current = []
    }
    return () => {
      isCurrent = false
      socket.close()
    }
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
      const sessionCrypto = sessionCryptoRef.current
      if (!sessionCrypto) throw new Error('Encrypted relay session is not ready')
      if (ok) {
        if (!result) {
          pending.resolve(null)
          return
        }
        pending.resolve(await decryptJson(sessionCrypto.dataKey, result))
        return
      }
      if (!errorEnvelope) {
        pending.reject(new Error('Remote action failed'))
        return
      }
      const decryptedError = await decryptJson<unknown>(sessionCrypto.dataKey, errorEnvelope)
      pending.reject(new Error(encryptedRpcErrorMessage(decryptedError)))
    } catch (rpcError) {
      pending.reject(rpcError instanceof Error ? rpcError : new Error('Remote action failed'))
    }
  }

  async function processRelayUpdates(updates: RelayUpdate[]) {
    for (const update of updates) {
      await processRelayUpdate(update)
    }
  }

  async function processRelayUpdate(update: RelayUpdate) {
    if (update.body.t === 'session-bootstrap') {
      const keyPair = clientKeyPairRef.current
      if (!keyPair) {
        setError('Missing local pairing key material')
        return
      }
      try {
        sessionCryptoRef.current = bootstrapSessionCrypto(keyPair, update.body.material)
        setConnectionStatus('connected as client (encrypted)')
        const pendingUpdates = pendingEncryptedUpdatesRef.current
        pendingEncryptedUpdatesRef.current = []
        await processRelayUpdates(pendingUpdates)
      } catch (cryptoError) {
        setError(cryptoError instanceof Error ? cryptoError.message : 'Failed to establish encrypted relay session')
      }
      return
    }

    const sessionCrypto = sessionCryptoRef.current
    if (!sessionCrypto) {
      pendingEncryptedUpdatesRef.current.push(update)
      return
    }

    let decryptedPayload: unknown
    try {
      decryptedPayload = await decryptJson(sessionCrypto.dataKey, update.body.envelope)
    } catch (cryptoError) {
      setError(cryptoError instanceof Error ? cryptoError.message : 'Failed to decrypt relay update')
      return
    }

    const event = parseDaemonEvent(decryptedPayload)
    if (!event) return

    setSnapshot((current) => {
      const next = applySnapshotEvent(current, event) ?? (event.event.type === 'snapshot' ? event.event.snapshot : current)
      if (next) {
        setSelectedWorkspaceId((existing) => existing ?? next.workspaces[0]?.id ?? null)
        setSelectedThreadId((existing) => existing ?? next.threads[0]?.id ?? null)
      }
      return next
    })

    if (!event.thread_id) return
    const daemonEvent = event.event
    switch (daemonEvent.type) {
      case 'conversation-item-added':
      case 'conversation-item-updated':
        setThreadItems((current) => {
          const bucket = current[event.thread_id!] ?? []
          const index = bucket.findIndex(
            (item) => item.id === daemonEvent.item.id && item.kind === daemonEvent.item.kind,
          )
          const nextBucket = bucket.slice()
          if (index === -1) nextBucket.push(daemonEvent.item)
          else nextBucket[index] = daemonEvent.item
          nextBucket.sort((left, right) => left.created_at.localeCompare(right.created_at))
          return { ...current, [event.thread_id!]: nextBucket }
        })
        break
      default:
        break
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
        client_bundle: {
          encryption_variant: 'data_key_v1',
          public_key: publicKeyToBase64(keyPair),
        },
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

  async function handlePickImages(files: FileList | null) {
    const next = await filesToImageInputs(files)
    setAttachments((current) => [...current, ...next])
  }

  async function callRpc<T = unknown>(method: string, rpcParams: Record<string, unknown>) {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Remote connection is not ready')
    }
    const sessionCrypto = sessionCryptoRef.current
    if (!sessionCrypto) {
      throw new Error('Encrypted relay session is not ready')
    }

    const requestId = `remote-${requestCounter.current++}`
    const encryptedParams = await encryptJson(sessionCrypto.dataKey, rpcParams)
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pendingRpc.current.delete(requestId)
        reject(new Error(`Timed out waiting for ${method}`))
      }, 20_000)
      pendingRpc.current.set(requestId, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      })
      sendRelayMessage(socket, {
        type: 'rpc-call',
        request_id: requestId,
        method,
        params: encryptedParams,
      })
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
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Remote action failed')
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
    }).catch((error) => {
      setError(error instanceof Error ? error.message : 'Approval action failed')
    })
  }

  useEffect(() => {
    if (!selectedWorkspace) {
      setSelectedModel(null)
      setSelectedEffort('medium')
      setSelectedCollaborationMode(null)
      return
    }

    if (selectedThread) {
      setSelectedModel(selectedThread.codex.model_id ?? selectedWorkspace.models.find((model) => model.is_default)?.id ?? null)
      setSelectedEffort(
        selectedThread.codex.reasoning_effort ??
          reasoningOptions(snapshot, selectedWorkspace.id, selectedThread.codex.model_id ?? selectedModel)[0] ??
          'medium',
      )
      setSelectedCollaborationMode(
        selectedThread.codex.collaboration_mode_id ?? selectedWorkspace.collaboration_modes[0]?.id ?? null,
      )
      return
    }

    setSelectedModel(selectedWorkspace.models.find((model) => model.is_default)?.id ?? null)
    setSelectedEffort(reasoningOptions(snapshot, selectedWorkspace.id, selectedWorkspace.models.find((model) => model.is_default)?.id ?? null)[0] ?? 'medium')
    setSelectedCollaborationMode(selectedWorkspace.collaboration_modes[0]?.id ?? null)
  }, [selectedThread, selectedWorkspace, snapshot, selectedModel])

  useEffect(() => {
    if (!snapshot) return
    const validThreadIds = new Set(snapshot.threads.map((thread) => thread.id))
    setThreadItems((current) => {
      const nextEntries = Object.entries(current).filter(([threadId]) => validThreadIds.has(threadId))
      return nextEntries.length === Object.keys(current).length ? current : Object.fromEntries(nextEntries)
    })
  }, [snapshot])

  return (
    <main className="grid min-h-screen grid-cols-1 gap-4 p-4 text-white xl:grid-cols-[320px_minmax(0,1fr)_340px]">
      <Card className="flex min-h-[calc(100vh-2rem)] flex-col">
        <CardHeader>
          <p className="text-xs uppercase tracking-[0.35em] text-zinc-500">FalconDeck Remote</p>
          <CardTitle>Projects</CardTitle>
          {!sessionId ? (
            <div className="space-y-3">
              <Input value={relayUrl} onChange={(event) => setRelayUrl(event.target.value)} placeholder="Relay URL" />
              <Input value={pairingCode} onChange={(event) => setPairingCode(event.target.value.toUpperCase())} placeholder="Pairing code" />
              <Button type="button" disabled={!relayUrl.trim() || !pairingCode.trim()} onClick={() => void handleClaimPairing()}>
                <Smartphone className="h-4 w-4" />
                Connect Remote
              </Button>
              <CardDescription className="text-emerald-300/80">End-to-end encrypted relay session</CardDescription>
            </div>
          ) : (
            <div className="space-y-1">
              <CardDescription>{connectionStatus}</CardDescription>
              <CardDescription className="text-emerald-300/80">End-to-end encrypted relay session</CardDescription>
            </div>
          )}
          {error ? <CardDescription className="text-rose-300">{error}</CardDescription> : null}
        </CardHeader>
        <CardContent className="min-h-0 flex-1">
          <ScrollArea className="h-[calc(100vh-12rem)]">
            <div className="space-y-4 pr-3">
              {groups.map((group) => (
                <section key={group.workspace.id} className="space-y-2">
                  <button
                    type="button"
                    className="w-full rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-left"
                    onClick={() => {
                      setSelectedWorkspaceId(group.workspace.id)
                      setSelectedThreadId(group.workspace.current_thread_id ?? group.threads[0]?.id ?? null)
                    }}
                  >
                    <p className="text-sm font-medium text-white">{projectLabel(group.workspace.path)}</p>
                    <p className="text-xs text-zinc-400">{group.workspace.path}</p>
                  </button>
                  <div className="space-y-2 pl-3">
                    {group.threads.map((thread) => (
                      <button
                        key={thread.id}
                        type="button"
                        className={`w-full rounded-2xl border px-4 py-3 text-left ${
                          selectedThreadId === thread.id ? 'border-emerald-300/40 bg-emerald-300/10' : 'border-white/8 bg-white/4'
                        }`}
                        onClick={() => {
                          setSelectedWorkspaceId(group.workspace.id)
                          setSelectedThreadId(thread.id)
                          setSelectedModel(thread.codex.model_id)
                          setSelectedEffort(thread.codex.reasoning_effort)
                          setSelectedCollaborationMode(thread.codex.collaboration_mode_id)
                        }}
                      >
                        <p className="text-sm font-medium text-white">{thread.title}</p>
                        <p className="mt-2 text-xs text-zinc-400">{thread.last_message_preview ?? 'No messages yet'}</p>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>

      <section className="grid min-h-[calc(100vh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto] gap-4">
        <Card>
          <CardContent className="flex flex-wrap items-center gap-3 pt-6">
            <div>
              <p className="text-xs uppercase tracking-[0.32em] text-zinc-500">Session</p>
              <h1 className="text-2xl font-semibold">
                {selectedWorkspace ? projectLabel(selectedWorkspace.path) : 'Waiting for daemon snapshot'}
              </h1>
            </div>
            <Badge variant={connectionStatus.includes('connected') ? 'success' : 'warning'}>{connectionStatus}</Badge>
            {selectedModel ? <Badge>{selectedWorkspace?.models.find((model) => model.id === selectedModel)?.label ?? selectedModel}</Badge> : null}
            {selectedEffort ? <Badge>{selectedEffort}</Badge> : null}
          </CardContent>
        </Card>

        <Conversation items={items} />

        <PromptInput
          value={draft}
          onValueChange={setDraft}
          onSubmit={() => void handleSubmit()}
          onPickImages={(files) => void handlePickImages(files)}
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
        />
      </section>

      <div className="grid min-h-[calc(100vh-2rem)] gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Approvals</CardTitle>
            <CardDescription>Allow or deny desktop permission prompts remotely.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {approvals.length === 0 ? <p className="text-sm text-zinc-400">No pending approvals.</p> : null}
            {approvals.map((approval) => (
              <div key={approval.request_id} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-sm font-medium text-white">{approval.title}</p>
                {approval.detail ? <p className="mt-2 text-sm text-zinc-400">{approval.detail}</p> : null}
                <div className="mt-4 flex gap-2">
                  <Button type="button" variant="secondary" onClick={() => handleApproval(approval.request_id, 'deny')}>
                    Deny
                  </Button>
                  <Button type="button" onClick={() => handleApproval(approval.request_id, 'allow')}>
                    Allow
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Latest plan</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {selectedThread?.latest_plan?.steps.map((step, index) => (
              <div key={`${step.step}-${index}`} className="flex items-center justify-between text-sm">
                <span>{step.step}</span>
                <span className="text-zinc-500">{step.status}</span>
              </div>
            )) ?? <p className="text-sm text-zinc-400">Plans will appear here during a run.</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Latest diff</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-2xl border border-white/10 bg-zinc-950 p-4 text-xs text-zinc-300">
              {selectedThread?.latest_diff ?? 'Patch updates will show up here during a run.'}
            </pre>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}

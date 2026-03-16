import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FolderPlus, LoaderCircle, RadioTower, Smartphone } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'

import {
  applyEventToThreadDetail,
  buildProjectGroups,
  createDaemonApiClient,
  projectLabel,
  type ConversationItem,
  type DaemonSnapshot,
  type EventEnvelope,
  type ImageInput,
  type RemoteStatusResponse,
  type ThreadDetail,
  type ThreadSummary,
  type TurnInputItem,
  type WorkspaceSummary,
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

import { detectApiBaseUrl } from './api'

type ConnectionState = 'connecting' | 'ready' | 'error'

function selectedModelId(thread: ThreadSummary | null, workspace: WorkspaceSummary | null) {
  return thread?.codex.model_id ?? workspace?.models.find((model) => model.is_default)?.id ?? null
}

function reasoningOptions(thread: ThreadSummary | null, workspace: WorkspaceSummary | null) {
  const model = workspace?.models.find((entry) => entry.id === selectedModelId(thread, workspace))
  const options = model?.supported_reasoning_efforts.map((entry) => entry.reasoning_effort) ?? []
  if (options.length > 0) return options
  return model?.default_reasoning_effort ? [model.default_reasoning_effort] : ['medium']
}

function remoteTone(status: RemoteStatusResponse['status']) {
  switch (status) {
    case 'connected':
      return 'success'
    case 'error':
      return 'danger'
    case 'waiting_for_claim':
    case 'connecting':
      return 'warning'
    default:
      return 'default'
  }
}

function remoteHeadline(status: RemoteStatusResponse['status'] | undefined) {
  switch (status) {
    case 'connected':
      return 'Remote connected'
    case 'connecting':
      return 'Connecting remote session'
    case 'waiting_for_claim':
      return 'Waiting for phone or browser'
    case 'error':
      return 'Remote connection error'
    default:
      return 'Remote inactive'
  }
}

function remoteDescription(status: RemoteStatusResponse | null) {
  switch (status?.status) {
    case 'connected':
      return 'A remote client is attached through the public relay and can follow the live session.'
    case 'connecting':
      return 'The pairing was claimed and the desktop daemon is negotiating the relay bridge.'
    case 'waiting_for_claim':
      return 'Scan the QR code or open the pairing link on your phone to attach the remote client.'
    case 'error':
      return status.last_error ?? 'The daemon could not establish the relay bridge.'
    default:
      return 'Start pairing to connect this desktop to FalconDeck Remote.'
  }
}

function statusTone(status: ThreadSummary['status'] | undefined) {
  switch (status) {
    case 'running':
      return 'warning'
    case 'waiting_for_approval':
      return 'warning'
    case 'error':
      return 'danger'
    default:
      return 'default'
  }
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

export default function App() {
  const [baseUrl, setBaseUrl] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting')
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(null)
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null)
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatusResponse | null>(null)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [workspacePath, setWorkspacePath] = useState('')
  const [draft, setDraft] = useState('')
  const [relayUrl, setRelayUrl] = useState(import.meta.env.VITE_FALCONDECK_RELAY_URL ?? 'https://connect.falcondeck.com')
  const [attachments, setAttachments] = useState<ImageInput[]>([])
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [selectedEffort, setSelectedEffort] = useState<string | null>('medium')
  const [selectedCollaborationMode, setSelectedCollaborationMode] = useState<string | null>(null)
  const [isAddingProject, setIsAddingProject] = useState(false)
  const [isStartingRemote, setIsStartingRemote] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const api = useMemo(() => (baseUrl ? createDaemonApiClient(baseUrl) : null), [baseUrl])
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
    () =>
      (snapshot?.approvals ?? []).filter(
        (approval) => !selectedThreadId || approval.thread_id === selectedThreadId,
      ),
    [selectedThreadId, snapshot?.approvals],
  )
  const remoteWebUrl = import.meta.env.VITE_FALCONDECK_REMOTE_WEB_URL ?? 'https://app.falcondeck.com'
  const pairingLink =
    remoteStatus?.pairing && remoteStatus.relay_url
      ? `${remoteWebUrl}?relay=${encodeURIComponent(remoteStatus.relay_url)}&code=${encodeURIComponent(
          remoteStatus.pairing.pairing_code,
        )}`
      : null

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
        setSelectedWorkspaceId((current) => current ?? nextSnapshot.workspaces[0]?.id ?? null)
        setSelectedThreadId((current) => current ?? nextSnapshot.threads[0]?.id ?? null)
        setConnectionState('ready')
        setActionError(null)
        socket = nextApi.connectEvents((event) => {
          setSnapshot((current) => applySnapshotEvent(current, event))
          setThreadDetail((current) => applyEventToThreadDetail(current, event))
        })
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
  }, [])

  useEffect(() => {
    if (!api || !selectedWorkspaceId || !selectedThreadId) {
      setThreadDetail(null)
      return
    }
    let cancelled = false
    void api
      .threadDetail(selectedWorkspaceId, selectedThreadId)
      .then((detail) => {
        if (!cancelled) {
          setThreadDetail(detail)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setThreadDetail(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [api, selectedThreadId, selectedWorkspaceId])

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
        selectedThread.codex.reasoning_effort ?? reasoningOptions(selectedThread, selectedWorkspace)[0] ?? 'medium',
      )
      setSelectedCollaborationMode(
        selectedThread.codex.collaboration_mode_id ?? selectedWorkspace.collaboration_modes[0]?.id ?? null,
      )
      return
    }
    setSelectedModel(selectedWorkspace.models.find((model) => model.is_default)?.id ?? null)
    setSelectedEffort(selectedWorkspace.models.find((model) => model.is_default)?.default_reasoning_effort ?? 'medium')
    setSelectedCollaborationMode(selectedWorkspace.collaboration_modes[0]?.id ?? null)
  }, [selectedThread, selectedWorkspace])

  useEffect(() => {
    if (!api || !remoteStatus || remoteStatus.status === 'inactive') return
    const interval = window.setInterval(() => {
      void api.remoteStatus().then(setRemoteStatus).catch(() => {})
    }, 2000)
    return () => window.clearInterval(interval)
  }, [api, remoteStatus?.status])

  async function handleAddProject() {
    if (!api) return
    if (workspacePath.trim()) {
      setIsAddingProject(true)
      try {
        const workspace = await api.connectWorkspace(workspacePath.trim())
        const nextSnapshot = await api.snapshot()
        setSnapshot(nextSnapshot)
        setSelectedWorkspaceId(workspace.id)
        setSelectedThreadId(workspace.current_thread_id)
        setWorkspacePath('')
        setActionError(null)
      } catch (error) {
        setActionError(error instanceof Error ? error.message : 'Failed to add project')
      } finally {
        setIsAddingProject(false)
      }
      return
    }

    if (!window.__TAURI_INTERNALS__) return
    setIsAddingProject(true)
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const selected = await open({ directory: true, multiple: false, title: 'Add Project' })
      if (typeof selected === 'string' && selected.trim()) {
        const workspace = await api.connectWorkspace(selected.trim())
        const nextSnapshot = await api.snapshot()
        setSnapshot(nextSnapshot)
        setSelectedWorkspaceId(workspace.id)
        setSelectedThreadId(workspace.current_thread_id)
        setActionError(null)
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to add project')
    } finally {
      setIsAddingProject(false)
    }
  }

  async function handleSubmit() {
    if (!api || !selectedWorkspace || !draft.trim()) return
    setIsSending(true)
    try {
      let activeThreadId = selectedThreadId
      if (!activeThreadId) {
        const handle = await api.startThread({
          workspace_id: selectedWorkspace.id,
          model_id: selectedModel,
          collaboration_mode_id: selectedCollaborationMode,
          approval_policy: 'on-request',
        })
        activeThreadId = handle.thread.id
        setSelectedThreadId(activeThreadId)
        setSnapshot((current) =>
          current
            ? {
                ...current,
                threads: [handle.thread, ...current.threads.filter((thread) => thread.id !== handle.thread.id)],
              }
            : current,
        )
      }

      const inputs: TurnInputItem[] = [{ type: 'text', text: draft }]
      for (const attachment of attachments) {
        inputs.push(attachment)
      }

      await api.sendTurn({
        workspace_id: selectedWorkspace.id,
        thread_id: activeThreadId,
        inputs,
        model_id: selectedModel,
        reasoning_effort: selectedEffort,
        collaboration_mode_id: selectedCollaborationMode,
        approval_policy: 'on-request',
      })
      setDraft('')
      setAttachments([])
      setActionError(null)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to send turn')
    } finally {
      setIsSending(false)
    }
  }

  async function handlePickImages(files: FileList | null) {
    const next = await filesToImageInputs(files)
    setAttachments((current) => [...current, ...next])
  }

  async function handleStartRemotePairing() {
    if (!api) return
    setIsStartingRemote(true)
    try {
      const nextStatus = await api.startRemotePairing(relayUrl)
      setRemoteStatus(nextStatus)
      setActionError(null)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to start remote pairing')
    } finally {
      setIsStartingRemote(false)
    }
  }

  async function handleApproval(requestId: string, decision: 'allow' | 'deny' | 'always_allow') {
    if (!api || !selectedWorkspaceId) return
    try {
      await api.respondApproval(selectedWorkspaceId, requestId, decision)
      const nextSnapshot = await api.snapshot()
      setSnapshot(nextSnapshot)
      setActionError(null)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Failed to respond to approval')
    }
  }

  const conversationItems: ConversationItem[] = threadDetail?.items ?? []

  return (
    <main className="grid min-h-screen grid-cols-1 gap-4 bg-[radial-gradient(circle_at_top_left,rgba(16,185,129,0.16),transparent_24%),linear-gradient(180deg,#060907_0%,#040605_100%)] p-4 text-white xl:grid-cols-[320px_minmax(0,1fr)_360px]">
      <Card className="flex min-h-[calc(100vh-2rem)] flex-col">
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.38em] text-zinc-500">FalconDeck</p>
              <CardTitle className="mt-3 text-4xl">Projects</CardTitle>
            </div>
            <Badge variant={connectionState === 'error' ? 'danger' : connectionState === 'ready' ? 'success' : 'warning'}>
              {connectionState === 'connecting' ? 'Connecting' : connectionState === 'error' ? 'Error' : 'Ready'}
            </Badge>
          </div>
          <div className="flex gap-2">
            <Input
              value={workspacePath}
              onChange={(event) => setWorkspacePath(event.target.value)}
              placeholder="/Users/james/..."
            />
            <Button type="button" onClick={() => void handleAddProject()} disabled={isAddingProject}>
              {isAddingProject ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <FolderPlus className="h-4 w-4" />}
              Add Project
            </Button>
          </div>
          {connectionError ? <CardDescription className="text-rose-300">{connectionError}</CardDescription> : null}
          {actionError ? <CardDescription className="text-amber-200">{actionError}</CardDescription> : null}
        </CardHeader>
        <CardContent className="min-h-0 flex-1 pb-6">
          <ScrollArea className="h-[calc(100vh-14rem)]">
            <div className="space-y-5 pr-3">
              {groups.map((group) => (
                <section key={group.workspace.id} className="space-y-2">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-4 py-3 text-left"
                    onClick={() => {
                      setSelectedWorkspaceId(group.workspace.id)
                      setSelectedThreadId(group.workspace.current_thread_id ?? group.threads[0]?.id ?? null)
                    }}
                  >
                    <div>
                      <p className="text-sm font-medium text-white">{projectLabel(group.workspace.path)}</p>
                      <p className="text-xs text-zinc-400">{group.workspace.path}</p>
                    </div>
                    <Badge variant={group.workspace.status === 'needs_auth' ? 'warning' : 'default'}>
                      {group.workspace.status.replaceAll('_', ' ')}
                    </Badge>
                  </button>
                  <div className="space-y-2 pl-3">
                    {group.threads.map((thread) => (
                      <button
                        key={thread.id}
                        type="button"
                        className={`w-full rounded-2xl border px-4 py-3 text-left transition ${
                          selectedThreadId === thread.id
                            ? 'border-emerald-300/40 bg-emerald-300/10'
                            : 'border-white/8 bg-white/4 hover:bg-white/8'
                        }`}
                        onClick={() => {
                          setSelectedWorkspaceId(group.workspace.id)
                          setSelectedThreadId(thread.id)
                        }}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <p className="truncate text-sm font-medium text-white">{thread.title}</p>
                          <Badge variant={statusTone(thread.status)}>{thread.status.replaceAll('_', ' ')}</Badge>
                        </div>
                        <p className="mt-2 line-clamp-2 text-xs text-zinc-400">
                          {thread.last_message_preview ?? 'No messages yet'}
                        </p>
                      </button>
                    ))}
                    {group.threads.length === 0 ? (
                      <div className="rounded-2xl border border-dashed border-white/10 px-4 py-6 text-sm text-zinc-500">
                        No threads yet for this project.
                      </div>
                    ) : null}
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
              <p className="text-xs uppercase tracking-[0.3em] text-zinc-500">Current project</p>
              <h2 className="text-2xl font-semibold text-white">
                {selectedWorkspace ? projectLabel(selectedWorkspace.path) : 'Select a project'}
              </h2>
            </div>
            {selectedThread ? (
              <>
                <Badge variant={statusTone(selectedThread.status)}>{selectedThread.status.replaceAll('_', ' ')}</Badge>
                {selectedModel ? <Badge>{selectedWorkspace?.models.find((model) => model.id === selectedModel)?.label ?? selectedModel}</Badge> : null}
                {selectedEffort ? <Badge>{selectedEffort}</Badge> : null}
              </>
            ) : null}
            <div className="ml-auto flex items-center gap-2 text-sm text-zinc-400">
              <RadioTower className="h-4 w-4" />
              <span className={remoteStatus?.status === 'connected' ? 'text-emerald-300' : undefined}>
                {remoteHeadline(remoteStatus?.status)}
              </span>
            </div>
          </CardContent>
        </Card>

        <Conversation items={conversationItems} />

        <PromptInput
          value={draft}
          onValueChange={setDraft}
          onSubmit={() => void handleSubmit()}
          onPickImages={(files) => void handlePickImages(files)}
          attachments={attachments}
          models={selectedWorkspace?.models ?? []}
          selectedModelId={selectedModel}
          onModelChange={setSelectedModel}
          reasoningOptions={reasoningOptions(selectedThread, selectedWorkspace)}
          selectedEffort={selectedEffort}
          onEffortChange={setSelectedEffort}
          collaborationModes={selectedWorkspace?.collaboration_modes ?? []}
          selectedCollaborationModeId={selectedCollaborationMode}
          onCollaborationModeChange={setSelectedCollaborationMode}
          approvalPolicy="on-request"
          disabled={!selectedWorkspace || isSending}
        />
      </section>

      <div className="grid min-h-[calc(100vh-2rem)] gap-4">
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.38em] text-zinc-500">Remote</p>
                <CardTitle>Pair this desktop</CardTitle>
              </div>
              <Badge variant={remoteStatus ? remoteTone(remoteStatus.status) : 'default'}>
                {remoteStatus?.status ?? 'inactive'}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <Input value={relayUrl} onChange={(event) => setRelayUrl(event.target.value)} />
            <Button type="button" onClick={() => void handleStartRemotePairing()} disabled={isStartingRemote}>
              {isStartingRemote ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Smartphone className="h-4 w-4" />}
              Start Pairing
            </Button>
            <div className="rounded-2xl border border-white/10 bg-white/5 p-4">
              <p className="text-sm font-medium text-white">{remoteHeadline(remoteStatus?.status)}</p>
              <p className="mt-2 text-sm text-zinc-400">{remoteDescription(remoteStatus)}</p>
            </div>
            {pairingLink ? (
              <div className="space-y-3 rounded-3xl border border-white/10 bg-white/5 p-4">
                <div className="flex justify-center rounded-[28px] bg-zinc-950 p-5">
                  <QRCodeSVG value={pairingLink} size={180} bgColor="transparent" fgColor="#f8fff8" />
                </div>
                <p className="text-sm text-zinc-300">{pairingLink}</p>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-zinc-400">Code</span>
                  <span className="font-semibold text-white">{remoteStatus?.pairing?.pairing_code}</span>
                </div>
              </div>
            ) : (
              <p className="text-sm text-zinc-400">Start a pairing to generate the QR code for the remote web client.</p>
            )}
            {remoteStatus?.last_error ? (
              <div className="rounded-2xl border border-rose-300/20 bg-rose-300/5 p-4 text-sm text-rose-200">
                <div className="mb-2 flex items-center gap-2 font-medium">
                  <AlertTriangle className="h-4 w-4" />
                  Remote error
                </div>
                {remoteStatus.last_error}
              </div>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Approvals</CardTitle>
            <CardDescription>Permission requests for the selected thread.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {approvals.length === 0 ? <p className="text-sm text-zinc-400">No pending approvals.</p> : null}
            {approvals.map((approval) => (
              <div key={approval.request_id} className="rounded-2xl border border-white/10 bg-white/5 p-4">
                <p className="text-sm font-medium text-white">{approval.title}</p>
                {approval.detail ? <p className="mt-2 text-sm text-zinc-400">{approval.detail}</p> : null}
                <div className="mt-4 flex gap-2">
                  <Button type="button" variant="secondary" onClick={() => void handleApproval(approval.request_id, 'deny')}>
                    Deny
                  </Button>
                  <Button type="button" onClick={() => void handleApproval(approval.request_id, 'allow')}>
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
            <CardDescription>Current Codex plan for the selected thread.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {selectedThread?.latest_plan?.steps.length ? (
              selectedThread.latest_plan.steps.map((step, index) => (
                <div key={`${step.step}-${index}`} className="flex items-center justify-between text-sm">
                  <span className="text-zinc-100">{step.step}</span>
                  <span className="text-zinc-500">{step.status}</span>
                </div>
              ))
            ) : (
              <p className="text-sm text-zinc-400">Plans will appear here during a run.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Latest diff</CardTitle>
            <CardDescription>Most recent patch preview for the selected thread.</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-2xl border border-white/10 bg-zinc-950 p-4 text-xs text-zinc-300">
              {selectedThread?.latest_diff ?? 'Diff updates will show up here during a run.'}
            </pre>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}

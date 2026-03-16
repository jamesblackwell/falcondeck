import { useEffect, useMemo, useRef, useState } from 'react'

import {
  applyEventToThreadDetail,
  applySnapshotEvent,
  buildProjectGroups,
  createDaemonApiClient,
  filesToImageInputs,
  type ConversationItem,
  type DaemonSnapshot,
  type ImageInput,
  type RemoteStatusResponse,
  type ThreadDetail,
  type TurnInputItem,
} from '@falcondeck/client-core'
import { Conversation, PromptInput } from '@falcondeck/chat-ui'
import { AppShell } from '@falcondeck/ui'

import { detectApiBaseUrl } from './api'
import { defaultModelId, reasoningOptions } from './utils'
import { DesktopSidebar } from './components/Sidebar'
import { SessionHeader } from './components/SessionHeader'
import { ContextPanel } from './components/ContextPanel'

type ConnectionState = 'connecting' | 'ready' | 'error'

export default function App() {
  const [baseUrl, setBaseUrl] = useState<string | null>(null)
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting')
  const [connectionError, setConnectionError] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<DaemonSnapshot | null>(null)
  const [threadDetail, setThreadDetail] = useState<ThreadDetail | null>(null)
  const [remoteStatus, setRemoteStatus] = useState<RemoteStatusResponse | null>(null)
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null)
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [relayUrl, setRelayUrl] = useState(
    import.meta.env.VITE_FALCONDECK_RELAY_URL ?? 'https://connect.falcondeck.com',
  )
  const [attachments, setAttachments] = useState<ImageInput[]>([])
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [selectedEffort, setSelectedEffort] = useState<string | null>('medium')
  const [selectedCollaborationMode, setSelectedCollaborationMode] = useState<string | null>(null)
  const [isAddingProject, setIsAddingProject] = useState(false)
  const [isStartingRemote, setIsStartingRemote] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const selectionSeedRef = useRef<string | null>(null)

  const api = useMemo(() => (baseUrl ? createDaemonApiClient(baseUrl) : null), [baseUrl])
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
    () =>
      (snapshot?.approvals ?? []).filter(
        (a) => !selectedThreadId || a.thread_id === selectedThreadId,
      ),
    [selectedThreadId, snapshot?.approvals],
  )
  const remoteWebUrl = import.meta.env.VITE_FALCONDECK_REMOTE_WEB_URL ?? 'https://app.falcondeck.com'
  const pairingLink =
    remoteStatus?.pairing && remoteStatus.relay_url
      ? `${remoteWebUrl}?relay=${encodeURIComponent(remoteStatus.relay_url)}&code=${encodeURIComponent(remoteStatus.pairing.pairing_code)}`
      : null

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
        setSelectedWorkspaceId((c) => c ?? nextSnapshot.workspaces[0]?.id ?? null)
        setSelectedThreadId((c) => c ?? nextSnapshot.threads[0]?.id ?? null)
        setConnectionState('ready')
        setActionError(null)
        socket = nextApi.connectEvents((event) => {
          setSnapshot((c) => applySnapshotEvent(c, event))
          setThreadDetail((c) => applyEventToThreadDetail(c, event))
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

  // Sync model/effort/mode selections from thread/workspace
  useEffect(() => {
    if (!selectedWorkspace) {
      setSelectedModel(null)
      setSelectedEffort('medium')
      setSelectedCollaborationMode(null)
      selectionSeedRef.current = null
      return
    }
    const seedKey = `${selectedWorkspace.id}:${selectedThread?.id ?? 'workspace'}`
    if (selectionSeedRef.current === seedKey) {
      return
    }
    selectionSeedRef.current = seedKey

    const fallbackModelId = defaultModelId(selectedWorkspace)
    if (selectedThread) {
      const nextModelId = selectedThread.codex.model_id ?? fallbackModelId
      setSelectedModel(nextModelId)
      setSelectedEffort(
        selectedThread.codex.reasoning_effort ??
          reasoningOptions(selectedThread, selectedWorkspace, nextModelId)[0] ??
          'medium',
      )
      setSelectedCollaborationMode(selectedThread.codex.collaboration_mode_id ?? selectedWorkspace.collaboration_modes[0]?.id ?? null)
      return
    }
    setSelectedModel(fallbackModelId)
    setSelectedEffort(reasoningOptions(null, selectedWorkspace, fallbackModelId)[0] ?? 'medium')
    setSelectedCollaborationMode(selectedWorkspace.collaboration_modes[0]?.id ?? null)
  }, [selectedThread, selectedWorkspace])

  useEffect(() => {
    if (!selectedWorkspace) return
    const options = reasoningOptions(selectedThread, selectedWorkspace, selectedModel)
    if (options.length === 0) return
    if (!selectedEffort || !options.includes(selectedEffort)) {
      setSelectedEffort(options[0] ?? 'medium')
    }
  }, [selectedEffort, selectedModel, selectedThread, selectedWorkspace])

  // Poll remote status
  useEffect(() => {
    if (!api || !remoteStatus || remoteStatus.status === 'inactive') return
    const interval = window.setInterval(() => {
      void api.remoteStatus().then(setRemoteStatus).catch(() => {})
    }, 2000)
    return () => window.clearInterval(interval)
  }, [api, remoteStatus?.status])

  async function handleAddProject(path: string) {
    if (!api) return
    setIsAddingProject(true)
    try {
      const workspace = await api.connectWorkspace(path)
      const nextSnapshot = await api.snapshot()
      setSnapshot(nextSnapshot)
      setSelectedWorkspaceId(workspace.id)
      setSelectedThreadId(workspace.current_thread_id)
      setActionError(null)
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
        setSnapshot((c) =>
          c ? { ...c, threads: [handle.thread, ...c.threads.filter((t) => t.id !== handle.thread.id)] } : c,
        )
      }
      const inputs: TurnInputItem[] = [{ type: 'text', text: draft }, ...attachments]
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
    <AppShell
      sidebar={
        <DesktopSidebar
          connectionState={connectionState}
          connectionError={connectionError}
          actionError={actionError}
          groups={groups}
          selectedWorkspaceId={selectedWorkspaceId}
          selectedThreadId={selectedThreadId}
          onSelectWorkspace={(workspaceId, threadId) => {
            setSelectedWorkspaceId(workspaceId)
            setSelectedThreadId(threadId)
          }}
          onSelectThread={(workspaceId, threadId) => {
            setSelectedWorkspaceId(workspaceId)
            setSelectedThreadId(threadId)
          }}
          onAddProject={handleAddProject}
          isAddingProject={isAddingProject}
        />
      }
      main={
        <section className="flex min-h-[calc(100vh-24px)] flex-col overflow-hidden rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1">
          <SessionHeader
            workspace={selectedWorkspace}
            thread={selectedThread}
            selectedModel={selectedModel}
            selectedEffort={selectedEffort}
            remoteStatus={remoteStatus}
          />
          <Conversation items={conversationItems} />
          <PromptInput
            value={draft}
            onValueChange={setDraft}
            onSubmit={() => void handleSubmit()}
            onPickImages={(files) => void filesToImageInputs(files).then((next) => setAttachments((c) => [...c, ...next]))}
            attachments={attachments}
            models={selectedWorkspace?.models ?? []}
            selectedModelId={selectedModel}
            onModelChange={setSelectedModel}
            reasoningOptions={reasoningOptions(selectedThread, selectedWorkspace, selectedModel)}
            selectedEffort={selectedEffort}
            onEffortChange={setSelectedEffort}
            collaborationModes={selectedWorkspace?.collaboration_modes ?? []}
            selectedCollaborationModeId={selectedCollaborationMode}
            onCollaborationModeChange={setSelectedCollaborationMode}
            approvalPolicy="on-request"
            disabled={!selectedWorkspace || isSending}
          />
        </section>
      }
      rail={
        <ContextPanel
          remoteStatus={remoteStatus}
          pairingLink={pairingLink}
          relayUrl={relayUrl}
          onRelayUrlChange={setRelayUrl}
          onStartPairing={() => void handleStartRemotePairing()}
          isStartingRemote={isStartingRemote}
          approvals={approvals}
          onApproval={(requestId, decision) => void handleApproval(requestId, decision)}
          thread={selectedThread}
        />
      }
    />
  )
}

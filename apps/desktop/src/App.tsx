import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  applyEventToThreadDetail,
  applySnapshotEvent,
  buildProjectGroups,
  createDaemonApiClient,
  filesToImageInputs,
  reconcileSnapshotSelection,
  type ConversationItem,
  type DaemonSnapshot,
  type EventEnvelope,
  type ImageInput,
  type RemoteStatusResponse,
  type ThreadDetail,
  type ThreadHandle,
  type TurnInputItem,
} from '@falcondeck/client-core'
import { Conversation, PromptInput } from '@falcondeck/chat-ui'

import { detectApiBaseUrl } from './api'
import { defaultModelId, reasoningOptions } from './utils'
import { DesktopSidebar } from './components/Sidebar'
import { DesktopShell } from './components/DesktopShell'
import { SessionHeader } from './components/SessionHeader'
import { RemotePairingPopover } from './components/RemotePairingPopover'
import { ApprovalBar } from './components/ApprovalBar'
import { DiffPanel } from './components/DiffPanel'

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
  const [gitRefreshTrigger, setGitRefreshTrigger] = useState(0)
  const selectionSeedRef = useRef<string | null>(null)
  const threadSettingsRequestRef = useRef(0)

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
        setActionError(null)
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

  useEffect(() => {
    const nextSelection = reconcileSnapshotSelection(snapshot, selectedWorkspaceId, selectedThreadId)
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
      if (!api || !selectedWorkspace || !selectedThreadId) return
      const requestId = ++threadSettingsRequestRef.current
      try {
        const handle = await api.updateThread({
          workspace_id: selectedWorkspace.id,
          thread_id: selectedThreadId,
          model_id: modelId,
          reasoning_effort: effort,
          collaboration_mode_id: collaborationModeId,
        })
        if (requestId !== threadSettingsRequestRef.current) return
        applyThreadHandle(handle)
        setActionError(null)
      } catch (error) {
        if (requestId !== threadSettingsRequestRef.current) return
        setActionError(error instanceof Error ? error.message : 'Failed to update thread settings')
      }
    },
    [api, applyThreadHandle, selectedThreadId, selectedWorkspace],
  )

  const handleModelChange = useCallback(
    (modelId: string) => {
      setSelectedModel(modelId)
      const nextOptions = reasoningOptions(selectedThread, selectedWorkspace, modelId)
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
      selectedThread,
      selectedWorkspace,
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

  async function handleAddProject() {
    if (!api) return
    setIsAddingProject(true)
    try {
      let path: string | null = null
      if (window.__TAURI_INTERNALS__) {
        const { open } = await import('@tauri-apps/plugin-dialog')
        const selected = await open({ directory: true, multiple: false, title: 'Add Project' })
        if (typeof selected === 'string') path = selected.trim()
      }
      if (!path) {
        setIsAddingProject(false)
        return
      }
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

  const handleSelectWorkspace = useCallback((workspaceId: string, threadId: string | null) => {
    setSelectedWorkspaceId(workspaceId)
    setSelectedThreadId(threadId)
  }, [])

  const handleSelectThread = useCallback((workspaceId: string, threadId: string) => {
    setSelectedWorkspaceId(workspaceId)
    setSelectedThreadId(threadId)
  }, [])

  const handleApprovalCallback = useCallback(
    (requestId: string, decision: 'allow' | 'deny' | 'always_allow') => {
      void handleApproval(requestId, decision)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, selectedWorkspaceId],
  )

  const handleSubmitCallback = useCallback(() => {
    void handleSubmit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, selectedWorkspace, selectedThreadId, draft, attachments, selectedModel, selectedEffort, selectedCollaborationMode])

  const handlePickImages = useCallback(
    (files: FileList | null) => {
      void filesToImageInputs(files).then((next) => setAttachments((c) => [...c, ...next]))
    },
    [],
  )

  const handleStartPairingCallback = useCallback(() => {
    void handleStartRemotePairing()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, relayUrl])

  const currentReasoningOptions = useMemo(
    () => reasoningOptions(selectedThread, selectedWorkspace, selectedModel),
    [selectedThread, selectedWorkspace, selectedModel],
  )

  const models = useMemo(() => selectedWorkspace?.models ?? [], [selectedWorkspace?.models])
  const collaborationModes = useMemo(() => selectedWorkspace?.collaboration_modes ?? [], [selectedWorkspace?.collaboration_modes])
  const isDisabled = !selectedWorkspace || isSending

  return (
    <DesktopShell
      sidebar={
        <DesktopSidebar
          connectionState={connectionState}
          connectionError={connectionError}
          actionError={actionError}
          groups={groups}
          selectedWorkspaceId={selectedWorkspaceId}
          selectedThreadId={selectedThreadId}
          onSelectWorkspace={handleSelectWorkspace}
          onSelectThread={handleSelectThread}
          onAddProject={handleAddProject}
          isAddingProject={isAddingProject}
        />
      }
      main={
        <section className="flex h-full min-h-0 flex-col bg-surface-1">
          <SessionHeader
            workspace={selectedWorkspace}
            thread={selectedThread}
            selectedModel={selectedModel}
            selectedEffort={selectedEffort}
          >
            <RemotePairingPopover
              remoteStatus={remoteStatus}
              pairingLink={pairingLink}
              relayUrl={relayUrl}
              onRelayUrlChange={setRelayUrl}
              onStartPairing={handleStartPairingCallback}
              isStartingRemote={isStartingRemote}
            />
          </SessionHeader>
          <ApprovalBar
            approvals={approvals}
            onApproval={handleApprovalCallback}
          />
          <Conversation items={conversationItems} />
          <PromptInput
            value={draft}
            onValueChange={setDraft}
            onSubmit={handleSubmitCallback}
            onPickImages={handlePickImages}
            attachments={attachments}
            models={models}
            selectedModelId={selectedModel}
            onModelChange={handleModelChange}
            reasoningOptions={currentReasoningOptions}
            selectedEffort={selectedEffort}
            onEffortChange={handleEffortChange}
            collaborationModes={collaborationModes}
            selectedCollaborationModeId={selectedCollaborationMode}
            onCollaborationModeChange={handleCollaborationModeChange}
            approvalPolicy="on-request"
            disabled={isDisabled}
          />
        </section>
      }
      rail={
        <DiffPanel
          api={api}
          workspaceId={selectedWorkspaceId}
          refreshTrigger={gitRefreshTrigger}
        />
      }
    />
  )
}

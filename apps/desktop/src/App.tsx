import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  buildProjectGroups,
  conversationItemsForSelection,
  filesToImageInputs,
  type ConversationItem,
  type ImageInput,
  type InteractiveRequest,
  type InteractiveResponsePayload,
  type ThreadHandle,
  type TurnInputItem,
} from '@falcondeck/client-core'
import { Conversation, PromptInput } from '@falcondeck/chat-ui'
import { ToastProvider, useToast } from '@falcondeck/ui'
import { LoaderCircle } from 'lucide-react'

import { defaultModelId, defaultReasoningEffort, reasoningOptions } from './utils'
import { DesktopSidebar } from './components/Sidebar'
import { DesktopShell } from './components/DesktopShell'
import { SessionHeader } from './components/SessionHeader'
import { RemotePairingPopover } from './components/RemotePairingPopover'
import { InteractiveRequestBar } from './components/InteractiveRequestBar'
import { DiffPanel } from './components/DiffPanel'
import { NewThreadState } from './components/NewThreadState'
import { useDaemonConnection } from './hooks/useDaemonConnection'

export default function App() {
  return (
    <ToastProvider>
      <AppInner />
    </ToastProvider>
  )
}

function AppInner() {
  const { toast } = useToast()
  const {
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
  } = useDaemonConnection()

  const [draft, setDraft] = useState('')
  const [relayUrl] = useState(
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
  const threadSettingsRequestRef = useRef(0)

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
  const remoteWebUrl = import.meta.env.VITE_FALCONDECK_REMOTE_WEB_URL ?? 'https://app.falcondeck.com'
  const pairingLink =
    remoteStatus?.pairing && remoteStatus.relay_url
      ? `${remoteWebUrl}?relay=${encodeURIComponent(remoteStatus.relay_url)}&code=${encodeURIComponent(remoteStatus.pairing.pairing_code)}`
      : null

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
    if (selectionSeedRef.current === seedKey) return
    selectionSeedRef.current = seedKey

    const fallbackModelId = defaultModelId(selectedWorkspace)
    if (selectedThread) {
      const nextModelId = selectedThread.codex.model_id ?? fallbackModelId
      setSelectedModel(nextModelId)
      setSelectedEffort(
        selectedThread.codex.reasoning_effort ??
          defaultReasoningEffort(selectedThread, selectedWorkspace, nextModelId) ??
          'medium',
      )
      setSelectedCollaborationMode(selectedThread.codex.collaboration_mode_id ?? selectedWorkspace.collaboration_modes[0]?.id ?? null)
      return
    }
    setSelectedModel(fallbackModelId)
    setSelectedEffort(defaultReasoningEffort(null, selectedWorkspace, fallbackModelId) ?? 'medium')
    setSelectedCollaborationMode(selectedWorkspace.collaboration_modes[0]?.id ?? null)
  }, [selectedThread, selectedWorkspace])

  useEffect(() => {
    if (!selectedWorkspace) return
    const options = reasoningOptions(selectedThread, selectedWorkspace, selectedModel)
    if (options.length === 0) return
    if (!selectedEffort || !options.includes(selectedEffort)) {
      setSelectedEffort(defaultReasoningEffort(selectedThread, selectedWorkspace, selectedModel))
    }
  }, [selectedEffort, selectedModel, selectedThread, selectedWorkspace])

  // Surface connection errors as toasts
  useEffect(() => {
    if (connectionError) {
      toast({ variant: 'danger', title: 'Connection error', description: connectionError })
    }
  }, [connectionError, toast])

  const applyThreadHandle = useCallback((handle: ThreadHandle) => {
    setSnapshot((current) =>
      current
        ? {
            ...current,
            workspaces: current.workspaces.map((w) =>
              w.id === handle.workspace.id ? handle.workspace : w,
            ),
            threads: current.threads.map((t) =>
              t.id === handle.thread.id ? handle.thread : t,
            ),
          }
        : current,
    )
    setThreadDetail((current) =>
      current && current.thread.id === handle.thread.id
        ? { ...current, workspace: handle.workspace, thread: handle.thread }
        : current,
    )
  }, [setSnapshot, setThreadDetail])

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
        const msg = error instanceof Error ? error.message : 'Failed to update thread settings'
        setActionError(msg)
        toast({ variant: 'danger', title: 'Failed to update settings', description: msg })
      }
    },
    [api, applyThreadHandle, selectedThreadId, selectedWorkspace, toast],
  )

  const handleModelChange = useCallback(
    (modelId: string) => {
      setSelectedModel(modelId)
      const nextOptions = reasoningOptions(selectedThread, selectedWorkspace, modelId)
      const nextEffort =
        selectedEffort && nextOptions.includes(selectedEffort)
          ? selectedEffort
          : defaultReasoningEffort(selectedThread, selectedWorkspace, modelId)
      setSelectedEffort(nextEffort)
      void persistThreadSettings({ modelId, effort: nextEffort, collaborationModeId: selectedCollaborationMode })
    },
    [persistThreadSettings, selectedCollaborationMode, selectedEffort, selectedThread, selectedWorkspace],
  )

  const handleEffortChange = useCallback(
    (effort: string) => {
      setSelectedEffort(effort)
      void persistThreadSettings({ modelId: selectedModel, effort, collaborationModeId: selectedCollaborationMode })
    },
    [persistThreadSettings, selectedCollaborationMode, selectedModel],
  )

  const handleCollaborationModeChange = useCallback(
    (modeId: string) => {
      setSelectedCollaborationMode(modeId)
      void persistThreadSettings({ modelId: selectedModel, effort: selectedEffort, collaborationModeId: modeId })
    },
    [persistThreadSettings, selectedEffort, selectedModel],
  )

  const handleAddProject = useCallback(async () => {
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
      const msg = error instanceof Error ? error.message : 'Failed to add project'
      setActionError(msg)
      toast({ variant: 'danger', title: 'Failed to add project', description: msg })
    } finally {
      setIsAddingProject(false)
    }
  }, [api, setSnapshot, setSelectedThreadId, setSelectedWorkspaceId, toast])

  async function handleSubmit() {
    if (!api || !selectedWorkspace || !draft.trim()) return
    const submittedDraft = draft
    const submittedAttachments = attachments
    setDraft('')
    setAttachments([])
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
      const inputs: TurnInputItem[] = [{ type: 'text', text: submittedDraft }, ...submittedAttachments]
      await api.sendTurn({
        workspace_id: selectedWorkspace.id,
        thread_id: activeThreadId,
        inputs,
        model_id: selectedModel,
        reasoning_effort: selectedEffort,
        collaboration_mode_id: selectedCollaborationMode,
        approval_policy: 'on-request',
      })
      setActionError(null)
    } catch (error) {
      setDraft(submittedDraft)
      setAttachments(submittedAttachments)
      const msg = error instanceof Error ? error.message : 'Failed to send turn'
      setActionError(msg)
      toast({ variant: 'danger', title: 'Failed to send message', description: msg })
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
      const msg = error instanceof Error ? error.message : 'Failed to start remote pairing'
      setActionError(msg)
      toast({ variant: 'danger', title: 'Failed to start pairing', description: msg })
    } finally {
      setIsStartingRemote(false)
    }
  }

  async function handleInteractiveResponse(
    workspaceId: string,
    requestId: string,
    response: InteractiveResponsePayload,
  ) {
    if (!api) return
    try {
      await api.respondInteractive(workspaceId, requestId, response)
      const nextSnapshot = await api.snapshot()
      setSnapshot(nextSnapshot)
      setActionError(null)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to respond to request'
      setActionError(msg)
      toast({ variant: 'danger', title: 'Failed to respond', description: msg })
    }
  }

  // Stable callbacks for child components
  const handleSelectWorkspace = useCallback((workspaceId: string, threadId: string | null) => {
    setSelectedWorkspaceId(workspaceId)
    setSelectedThreadId(threadId)
  }, [setSelectedWorkspaceId, setSelectedThreadId])

  const handleSelectThread = useCallback((workspaceId: string, threadId: string) => {
    setSelectedWorkspaceId(workspaceId)
    setSelectedThreadId(threadId)
  }, [setSelectedWorkspaceId, setSelectedThreadId])

  const handleNewThread = useCallback((workspaceId: string) => {
    setSelectedWorkspaceId(workspaceId)
    setSelectedThreadId(null)
  }, [setSelectedWorkspaceId, setSelectedThreadId])

  const handleInteractiveResponseCallback = useCallback(
    (request: InteractiveRequest, response: InteractiveResponsePayload) => {
      void handleInteractiveResponse(request.workspace_id, request.request_id, response)
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api],
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

  const handleRefreshRemoteStatus = useCallback(() => {
    if (!api) return
    void api.remoteStatus().then(setRemoteStatus).catch(() => {})
  }, [api, setRemoteStatus])

  const handleArchiveThread = useCallback(
    (workspaceId: string, threadId: string) => {
      if (!api) return
      void api.archiveThread(workspaceId, threadId).then(() => {
        if (selectedThreadId === threadId) {
          setSelectedThreadId(null)
        }
        return api.snapshot().then(setSnapshot)
      }).catch((error: unknown) => {
        const msg = error instanceof Error ? error.message : 'Failed to archive thread'
        toast({ variant: 'danger', title: 'Failed to archive thread', description: msg })
      })
    },
    [api, selectedThreadId, setSelectedThreadId, setSnapshot, toast],
  )

  // Memoized derived values
  const isThreadDetailPending = Boolean(
    selectedThreadId &&
      (!threadDetail ||
        threadDetail.workspace.id !== selectedWorkspaceId ||
        threadDetail.thread.id !== selectedThreadId),
  )
  const conversationItems: ConversationItem[] = useMemo(
    () => conversationItemsForSelection(selectedWorkspaceId, selectedThreadId, threadDetail),
    [selectedThreadId, selectedWorkspaceId, threadDetail],
  )
  const currentReasoningOptions = useMemo(
    () => reasoningOptions(selectedThread, selectedWorkspace, selectedModel),
    [selectedThread, selectedWorkspace, selectedModel],
  )
  const models = useMemo(() => selectedWorkspace?.models ?? [], [selectedWorkspace?.models])
  const collaborationModes = useMemo(() => selectedWorkspace?.collaboration_modes ?? [], [selectedWorkspace?.collaboration_modes])
  const isDisabled = !selectedWorkspace || isSending
  const workspaces = useMemo(() => snapshot?.workspaces ?? [], [snapshot?.workspaces])

  const newThreadEmptyState = useMemo(
    () => (
      <NewThreadState
        workspaces={workspaces}
        selectedWorkspace={selectedWorkspace}
        onSelectWorkspace={handleNewThread}
      />
    ),
    [workspaces, selectedWorkspace, handleNewThread],
  )
  const loadingThreadState = useMemo(
    () => (
      <div className="flex min-h-[240px] items-center justify-center gap-2 text-[length:var(--fd-text-sm)] text-fg-muted">
        <LoaderCircle className="h-4 w-4 animate-spin text-accent" />
        Loading conversation…
      </div>
    ),
    [],
  )
  const conversationEmptyState = useMemo(() => {
    if (isThreadDetailPending) {
      return loadingThreadState
    }
    if (selectedThreadId) {
      return undefined
    }
    return newThreadEmptyState
  }, [isThreadDetailPending, loadingThreadState, newThreadEmptyState, selectedThreadId])

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
          onNewThread={handleNewThread}
          onArchiveThread={handleArchiveThread}
          onAddProject={handleAddProject}
          isAddingProject={isAddingProject}
        />
      }
      main={
        <section className="flex h-full min-h-0 flex-col bg-surface-1">
          <SessionHeader workspace={selectedWorkspace} thread={selectedThread}>
            <RemotePairingPopover
              remoteStatus={remoteStatus}
              pairingLink={pairingLink}
              onStartPairing={handleStartPairingCallback}
              onRefreshStatus={handleRefreshRemoteStatus}
              isStartingRemote={isStartingRemote}
            />
          </SessionHeader>
          <InteractiveRequestBar
            requests={interactiveRequests}
            onRespond={handleInteractiveResponseCallback}
          />
          <Conversation
            threadKey={
              selectedThreadId
                ? `${selectedWorkspaceId ?? 'workspace'}:${selectedThreadId}`
                : selectedWorkspaceId
            }
            items={conversationItems}
            emptyState={conversationEmptyState}
            isThinking={isSending || selectedThread?.status === 'running'}
            isLoading={isThreadDetailPending}
          />
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
            disabled={isDisabled}
          />
        </section>
      }
      rail={
        <DiffPanel api={api} workspaceId={selectedWorkspaceId} refreshTrigger={gitRefreshTrigger} />
      }
    />
  )
}

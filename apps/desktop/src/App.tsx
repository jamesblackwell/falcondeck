import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  buildProjectGroups,
  countAwaitingResponseThreads,
  conversationItemsForSelection,
  defaultCollaborationModeId,
  deriveThreadAttentionPresentation,
  filesToImageInputs,
  isPlanModeEnabled,
  providerForThread,
  supportsPlanMode,
  togglePlanMode,
  workspaceCollaborationModes,
  workspaceModels,
  type AgentProvider,
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
import { SettingsView } from './components/SettingsView'
import { useDaemonConnection } from './hooks/useDaemonConnection'

function markInteractiveRequestResolved(items: ConversationItem[], requestId: string): ConversationItem[] {
  return items.map((item) =>
    item.kind === 'interactive_request' && item.id === requestId
      ? { ...item, resolved: true }
      : item,
  )
}

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
  const [selectedProvider, setSelectedProvider] = useState<AgentProvider>('codex')
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [selectedEffort, setSelectedEffort] = useState<string | null>('medium')
  const [selectedCollaborationMode, setSelectedCollaborationMode] = useState<string | null>(null)
  const [isAddingProject, setIsAddingProject] = useState(false)
  const [isImportingProjectSessions, setIsImportingProjectSessions] = useState(false)
  const [isStartingRemote, setIsStartingRemote] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [windowFocused, setWindowFocused] = useState(() => document.visibilityState !== 'hidden')
  const selectionSeedRef = useRef<string | null>(null)
  const threadSettingsRequestRef = useRef(0)
  const notifiedAttentionRef = useRef(new Map<string, string>())

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
      setSelectedProvider('codex')
      setSelectedModel(null)
      setSelectedEffort('medium')
      setSelectedCollaborationMode(null)
      selectionSeedRef.current = null
      return
    }
    const seedKey = `${selectedWorkspace.id}:${selectedThread?.id ?? 'workspace'}`
    if (selectionSeedRef.current === seedKey) return
    selectionSeedRef.current = seedKey

    const nextProvider = providerForThread(selectedThread, selectedWorkspace)
    setSelectedProvider(nextProvider)
    const fallbackModelId = defaultModelId(selectedWorkspace, nextProvider)
    if (selectedThread) {
      const nextModelId = selectedThread.agent.model_id ?? fallbackModelId
      setSelectedModel(nextModelId)
      setSelectedEffort(
        selectedThread.agent.reasoning_effort ??
          defaultReasoningEffort(selectedThread, selectedWorkspace, nextModelId) ??
          'medium',
      )
      setSelectedCollaborationMode(defaultCollaborationModeId(selectedThread))
      return
    }
    setSelectedModel(fallbackModelId)
    setSelectedEffort(defaultReasoningEffort(null, selectedWorkspace, fallbackModelId) ?? 'medium')
    setSelectedCollaborationMode(null)
  }, [selectedThread, selectedWorkspace])

  useEffect(() => {
    if (!selectedWorkspace) return
    const options = reasoningOptions(selectedThread, selectedWorkspace, selectedModel)
    if (options.length === 0) return
    if (!selectedEffort || !options.includes(selectedEffort)) {
      setSelectedEffort(defaultReasoningEffort(selectedThread, selectedWorkspace, selectedModel))
    }
  }, [selectedEffort, selectedModel, selectedThread, selectedWorkspace])

  useEffect(() => {
    const handleFocus = () => setWindowFocused(true)
    const handleBlur = () => setWindowFocused(false)
    const handleVisibility = () => {
      setWindowFocused(document.visibilityState !== 'hidden' && document.hasFocus())
    }

    window.addEventListener('focus', handleFocus)
    window.addEventListener('blur', handleBlur)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('blur', handleBlur)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [])

  useEffect(() => {
    if (!api || !selectedWorkspaceId || !selectedThread) return
    if (!windowFocused) return
    const readSeq = selectedThread.attention.last_agent_activity_seq
    if (!readSeq || readSeq <= selectedThread.attention.last_read_seq) return

    void api
      .markThreadRead({
        workspace_id: selectedWorkspaceId,
        thread_id: selectedThread.id,
        read_seq: readSeq,
      })
      .then((thread) => {
        setSnapshot((current) =>
          current
            ? {
                ...current,
                threads: current.threads.map((entry) => (entry.id === thread.id ? thread : entry)),
              }
            : current,
        )
      })
      .catch(() => {})
  }, [api, selectedThread, selectedWorkspaceId, setSnapshot, windowFocused])

  useEffect(() => {
    const count = countAwaitingResponseThreads(snapshot?.threads ?? [])
    document.title = count > 0 ? `(${count}) FalconDeck` : 'FalconDeck'

    if (!window.__TAURI_INTERNALS__) return
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().setBadgeCount(count || undefined))
      .catch(() => {})
  }, [snapshot?.threads])

  useEffect(() => {
    if (!snapshot?.threads?.length) return

    for (const thread of snapshot.threads) {
      const attention = deriveThreadAttentionPresentation(thread, snapshot.interactive_requests)
      if (
        attention.level === 'none' ||
        (windowFocused && selectedThreadId === thread.id)
      ) {
        notifiedAttentionRef.current.delete(thread.id)
        continue
      }

      const previous = notifiedAttentionRef.current.get(thread.id)
      if (previous === attention.level) continue
      notifiedAttentionRef.current.set(thread.id, attention.level)

      if (typeof Notification === 'undefined') continue
      if (Notification.permission === 'default') {
        void Notification.requestPermission().catch(() => {})
        continue
      }
      if (Notification.permission !== 'granted') continue

      const body =
        attention.level === 'awaiting_response'
          ? 'The agent needs a response in this thread.'
          : attention.level === 'error'
            ? 'The latest run ended with an error.'
            : 'New activity in this thread.'
      new Notification(thread.title || 'FalconDeck thread', { body })
    }
  }, [selectedThreadId, snapshot?.interactive_requests, snapshot?.threads, windowFocused])

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
          provider: selectedThread?.provider ?? selectedProvider,
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
    [api, applyThreadHandle, selectedProvider, selectedThread, selectedThreadId, selectedWorkspace, toast],
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
    (modeId: string | null) => {
      setSelectedCollaborationMode(modeId)
      void persistThreadSettings({ modelId: selectedModel, effort: selectedEffort, collaborationModeId: modeId })
    },
    [persistThreadSettings, selectedEffort, selectedModel],
  )

  const handleProviderChange = useCallback(
    (provider: AgentProvider) => {
      if (selectedThread) return
      setSelectedProvider(provider)
      const fallbackModelId = defaultModelId(selectedWorkspace, provider)
      setSelectedModel(fallbackModelId)
      setSelectedEffort(defaultReasoningEffort(null, selectedWorkspace, fallbackModelId) ?? 'medium')
      setSelectedCollaborationMode(null)
    },
    [selectedThread, selectedWorkspace],
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
      setIsImportingProjectSessions(true)
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
      setIsImportingProjectSessions(false)
      setIsAddingProject(false)
    }
  }, [api, setSnapshot, setSelectedThreadId, setSelectedWorkspaceId, toast])

  async function handleSubmit() {
    if (!api || !selectedWorkspace || (!draft.trim() && attachments.length === 0)) return
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
          provider: selectedProvider,
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
      const inputs: TurnInputItem[] = [
        ...(submittedDraft.trim() ? [{ type: 'text', text: submittedDraft } satisfies TurnInputItem] : []),
        ...submittedAttachments,
      ]
      await api.sendTurn({
        workspace_id: selectedWorkspace.id,
        thread_id: activeThreadId,
        inputs,
        provider: selectedThread?.provider ?? selectedProvider,
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
      setThreadDetail((current) =>
        current && current.workspace.id === workspaceId
          ? {
              ...current,
              items: markInteractiveRequestResolved(current.items, requestId),
            }
          : current,
      )
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
    setIsSettingsOpen(false)
    setSelectedWorkspaceId(workspaceId)
    setSelectedThreadId(threadId)
  }, [setSelectedWorkspaceId, setSelectedThreadId])

  const handleSelectThread = useCallback((workspaceId: string, threadId: string) => {
    setIsSettingsOpen(false)
    setSelectedWorkspaceId(workspaceId)
    setSelectedThreadId(threadId)
  }, [setSelectedWorkspaceId, setSelectedThreadId])

  const handleNewThread = useCallback((workspaceId: string) => {
    setIsSettingsOpen(false)
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

  const handleOpenSettings = useCallback(() => {
    setIsSettingsOpen(true)
  }, [])

  const handleRevokeDevice = useCallback(
    (device: { device_id: string; label: string | null }) => {
      if (!api) return
      const confirmed = window.confirm(
        `Remove ${device.label ?? 'this device'} from trusted devices? It will need a new pairing code to reconnect.`,
      )
      if (!confirmed) return

      setRevokingDeviceId(device.device_id)
      void api
        .revokeRemoteDevice(device.device_id)
        .then((nextStatus) => {
          setRemoteStatus(nextStatus)
          setActionError(null)
          toast({
            variant: 'success',
            title: 'Device removed',
            description: `${device.label ?? 'Device'} can no longer access this session.`,
          })
        })
        .catch((error: unknown) => {
          const msg = error instanceof Error ? error.message : 'Failed to remove device'
          setActionError(msg)
          toast({ variant: 'danger', title: 'Failed to remove device', description: msg })
        })
        .finally(() => {
          setRevokingDeviceId(null)
        })
    },
    [api, toast, setRemoteStatus],
  )

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
  const models = useMemo(
    () => workspaceModels(selectedWorkspace, selectedProvider),
    [selectedProvider, selectedWorkspace],
  )
  const collaborationModes = useMemo(
    () => workspaceCollaborationModes(selectedWorkspace, selectedProvider),
    [selectedProvider, selectedWorkspace],
  )
  const showPlanModeToggle = useMemo(
    () => supportsPlanMode(selectedWorkspace, selectedProvider),
    [selectedProvider, selectedWorkspace],
  )
  const planModeEnabled = useMemo(
    () => isPlanModeEnabled(selectedCollaborationMode, selectedWorkspace, selectedProvider),
    [selectedCollaborationMode, selectedProvider, selectedWorkspace],
  )
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
    <>
      <DesktopShell
        sidebar={
          <DesktopSidebar
            groups={groups}
            selectedWorkspaceId={selectedWorkspaceId}
            selectedThreadId={selectedThreadId}
            onSelectWorkspace={handleSelectWorkspace}
            onSelectThread={handleSelectThread}
            onNewThread={handleNewThread}
            onArchiveThread={handleArchiveThread}
            onAddProject={handleAddProject}
            isAddingProject={isAddingProject}
            onOpenSettings={handleOpenSettings}
            settingsOpen={isSettingsOpen}
            errors={[connectionError, actionError].filter((value): value is string => Boolean(value))}
          />
        }
        main={
          isSettingsOpen ? (
            <SettingsView
              workspace={selectedWorkspace}
              remoteStatus={remoteStatus}
              pairingLink={pairingLink}
              relayUrl={relayUrl}
              isStartingRemote={isStartingRemote}
              revokingDeviceId={revokingDeviceId}
              onStartPairing={handleStartPairingCallback}
              onRefreshRemoteStatus={handleRefreshRemoteStatus}
              onRevokeDevice={handleRevokeDevice}
              onClose={() => setIsSettingsOpen(false)}
            />
          ) : (
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
              <InteractiveRequestBar
                requests={interactiveRequests}
                onRespond={handleInteractiveResponseCallback}
              />
              <PromptInput
                value={draft}
                onValueChange={setDraft}
                onSubmit={handleSubmitCallback}
                onPickImages={handlePickImages}
                attachments={attachments}
                selectedProvider={selectedProvider}
                onProviderChange={handleProviderChange}
                providerLocked={Boolean(selectedThread)}
                models={models}
                selectedModelId={selectedModel}
                onModelChange={handleModelChange}
                reasoningOptions={currentReasoningOptions}
                selectedEffort={selectedEffort}
                onEffortChange={handleEffortChange}
                collaborationModes={collaborationModes}
                selectedCollaborationModeId={selectedCollaborationMode}
                onCollaborationModeChange={(value) => handleCollaborationModeChange(value)}
                showPlanModeToggle={showPlanModeToggle}
                planModeEnabled={planModeEnabled}
                onPlanModeChange={(enabled) =>
                  handleCollaborationModeChange(
                    togglePlanMode(enabled, selectedWorkspace, selectedCollaborationMode, selectedProvider),
                  )
                }
                disabled={isDisabled}
              />
            </section>
          )
        }
        rail={
          isSettingsOpen
            ? undefined
            : <DiffPanel api={api} workspaceId={selectedWorkspaceId} refreshTrigger={gitRefreshTrigger} />
        }
      />
      {isImportingProjectSessions ? (
        <div className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-6 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 p-6 shadow-[var(--fd-shadow-lg)]">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full bg-surface-3 p-2 text-accent">
                <LoaderCircle className="h-5 w-5 animate-spin" />
              </div>
              <div className="space-y-1">
                <h2 className="text-[length:var(--fd-text-lg)] font-medium text-fg-primary">
                  Importing existing Claude and Codex sessions
                </h2>
                <p className="text-[length:var(--fd-text-sm)] text-fg-muted">
                  This might take a moment.
                </p>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}

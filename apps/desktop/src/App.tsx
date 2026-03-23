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
  selectedSkillsFromText,
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
  type UpdatePreferencesPayload,
} from '@falcondeck/client-core'
import { NewThreadState } from '@falcondeck/chat-ui'
import { ToastProvider, useToast } from '@falcondeck/ui'
import { LoaderCircle } from 'lucide-react'

import { markInteractiveRequestResolved, normalizeSendError, workspaceSendBlockReason } from './app-utils'
import {
  defaultReasoningEffort,
  reasoningOptions,
  resolveReasoningEffort,
  resolveThreadModelId,
} from './utils'
import { DesktopConversationPane } from './components/DesktopConversationPane'
import { DesktopSidebar } from './components/Sidebar'
import { DesktopShell } from './components/DesktopShell'
import { DiffPanel } from './components/DiffPanel'
import { ProjectImportOverlay } from './components/ProjectImportOverlay'
import { SettingsView } from './components/SettingsView'
import { useAppUpdater } from './hooks/useAppUpdater'
import { useDaemonConnection } from './hooks/useDaemonConnection'

const COMPOSER_SELECTIONS_STORAGE_KEY = 'falcondeck.desktop.composer-selections.v1'

type PersistedComposerSelection = {
  modelId: string | null
  effort: string | null
}

type PersistedComposerSelections = Record<
  string,
  Partial<Record<AgentProvider, PersistedComposerSelection>>
>

function readPersistedComposerSelections(): PersistedComposerSelections {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const raw = window.localStorage.getItem(COMPOSER_SELECTIONS_STORAGE_KEY)
    if (!raw) {
      return {}
    }
    const parsed = JSON.parse(raw) as Record<string, Record<string, PersistedComposerSelection>>
    const next: PersistedComposerSelections = {}

    for (const [workspacePath, selections] of Object.entries(parsed)) {
      if (!selections || typeof selections !== 'object') {
        continue
      }
      const workspaceSelections: Partial<Record<AgentProvider, PersistedComposerSelection>> = {}
      for (const provider of ['codex', 'claude'] as const) {
        const selection = selections[provider]
        if (!selection || typeof selection !== 'object') {
          continue
        }
        workspaceSelections[provider] = {
          modelId: typeof selection.modelId === 'string' ? selection.modelId : null,
          effort: typeof selection.effort === 'string' ? selection.effort : null,
        }
      }
      if (Object.keys(workspaceSelections).length > 0) {
        next[workspacePath] = workspaceSelections
      }
    }

    return next
  } catch {
    return {}
  }
}

function writePersistedComposerSelections(selections: PersistedComposerSelections) {
  if (typeof window === 'undefined') {
    return
  }

  try {
    window.localStorage.setItem(
      COMPOSER_SELECTIONS_STORAGE_KEY,
      JSON.stringify(selections),
    )
  } catch {
    // Ignore storage failures and keep the in-memory selection authoritative.
  }
}

function selectionForWorkspace(
  selections: PersistedComposerSelections,
  workspacePath: string | null | undefined,
  provider: AgentProvider,
) {
  if (!workspacePath) {
    return null
  }
  return selections[workspacePath]?.[provider] ?? null
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
  const updater = useAppUpdater()

  const [draft, setDraft] = useState('')
  const [relayUrl] = useState(
    import.meta.env.VITE_FALCONDECK_RELAY_URL ?? 'https://connect.falcondeck.com',
  )
  const [attachments, setAttachments] = useState<ImageInput[]>([])
  const [selectedProvider, setSelectedProvider] = useState<AgentProvider>('codex')
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [selectedEffort, setSelectedEffort] = useState<string | null>('medium')
  const [selectedCollaborationMode, setSelectedCollaborationMode] = useState<string | null>(null)
  const [persistedComposerSelections, setPersistedComposerSelections] =
    useState<PersistedComposerSelections>(() => readPersistedComposerSelections())
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
  const announcedUpdateVersionRef = useRef<string | null>(null)
  const announcedDownloadedVersionRef = useRef<string | null>(null)

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
  const defaultRelayUrl = 'https://connect.falcondeck.com'
  const pairingLink =
    remoteStatus?.pairing && remoteStatus.relay_url
      ? (() => {
          const params = new URLSearchParams({
            code: remoteStatus.pairing.pairing_code,
          })
          if (remoteStatus.relay_url !== defaultRelayUrl) {
            params.set('relay', remoteStatus.relay_url)
          }
          return `${remoteWebUrl}?${params.toString()}`
        })()
      : null

  const rememberComposerSelection = useCallback(
    (provider: AgentProvider, selection: PersistedComposerSelection) => {
      if (!selectedWorkspace) {
        return
      }

      setPersistedComposerSelections((current) => {
        const next = {
          ...current,
          [selectedWorkspace.path]: {
            ...(current[selectedWorkspace.path] ?? {}),
            [provider]: selection,
          },
        }
        writePersistedComposerSelections(next)
        return next
      })
    },
    [selectedWorkspace],
  )

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
    const preferredSelection = selectionForWorkspace(
      persistedComposerSelections,
      selectedWorkspace.path,
      nextProvider,
    )
    const nextModelId = resolveThreadModelId(
      selectedThread,
      selectedWorkspace,
      preferredSelection?.modelId,
      nextProvider,
    )
    setSelectedProvider(nextProvider)
    setSelectedModel(nextModelId)
    setSelectedEffort(
      resolveReasoningEffort(
        selectedThread,
        selectedWorkspace,
        nextModelId,
        preferredSelection?.effort,
        nextProvider,
      ) ?? 'medium',
    )
    setSelectedCollaborationMode(defaultCollaborationModeId(selectedThread))
  }, [persistedComposerSelections, selectedThread, selectedWorkspace])

  useEffect(() => {
    if (!selectedWorkspace) return
    const provider = selectedThread?.provider ?? selectedProvider
    const models = workspaceModels(selectedWorkspace, provider)
    if (models.length === 0) {
      if (selectedModel !== null) {
        setSelectedModel(null)
      }
      return
    }
    if (!selectedModel || !models.some((model) => model.id === selectedModel)) {
      const preferredSelection = selectionForWorkspace(
        persistedComposerSelections,
        selectedWorkspace.path,
        provider,
      )
      setSelectedModel(
        resolveThreadModelId(
          selectedThread,
          selectedWorkspace,
          preferredSelection?.modelId,
          provider,
        ),
      )
    }
  }, [
    persistedComposerSelections,
    selectedModel,
    selectedProvider,
    selectedThread,
    selectedWorkspace,
  ])

  useEffect(() => {
    if (!selectedWorkspace) return
    const provider = selectedThread?.provider ?? selectedProvider
    const options = reasoningOptions(selectedThread, selectedWorkspace, selectedModel, provider)
    if (options.length === 0) return
    if (!selectedEffort || !options.includes(selectedEffort)) {
      const preferredSelection = selectionForWorkspace(
        persistedComposerSelections,
        selectedWorkspace.path,
        provider,
      )
      setSelectedEffort(
        resolveReasoningEffort(
          selectedThread,
          selectedWorkspace,
          selectedModel,
          preferredSelection?.effort,
          provider,
        ),
      )
    }
  }, [
    persistedComposerSelections,
    selectedEffort,
    selectedModel,
    selectedProvider,
    selectedThread,
    selectedWorkspace,
  ])

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

  useEffect(() => {
    if (updater.state.status !== 'available' || !updater.state.availableVersion) return
    if (announcedUpdateVersionRef.current === updater.state.availableVersion) return
    announcedUpdateVersionRef.current = updater.state.availableVersion
    toast({
      variant: 'warning',
      title: 'Update available',
      description: `FalconDeck ${updater.state.availableVersion} is ready to download from GitHub Releases.`,
    })
  }, [toast, updater.state.availableVersion, updater.state.status])

  useEffect(() => {
    if (updater.state.status !== 'downloaded' || !updater.state.availableVersion) return
    if (announcedDownloadedVersionRef.current === updater.state.availableVersion) return
    announcedDownloadedVersionRef.current = updater.state.availableVersion
    toast({
      variant: 'success',
      title: 'Update downloaded',
      description: 'Restart FalconDeck when you are ready to install the new desktop build.',
    })
  }, [toast, updater.state.availableVersion, updater.state.status])

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
      const provider = selectedThread?.provider ?? selectedProvider
      setSelectedModel(modelId)
      const nextOptions = reasoningOptions(selectedThread, selectedWorkspace, modelId, provider)
      const nextEffort =
        selectedEffort && nextOptions.includes(selectedEffort)
          ? selectedEffort
          : defaultReasoningEffort(selectedThread, selectedWorkspace, modelId, provider)
      setSelectedEffort(nextEffort)
      rememberComposerSelection(provider, { modelId, effort: nextEffort })
      void persistThreadSettings({ modelId, effort: nextEffort, collaborationModeId: selectedCollaborationMode })
    },
    [
      persistThreadSettings,
      rememberComposerSelection,
      selectedCollaborationMode,
      selectedEffort,
      selectedProvider,
      selectedThread,
      selectedWorkspace,
    ],
  )

  const handleEffortChange = useCallback(
    (effort: string) => {
      const provider = selectedThread?.provider ?? selectedProvider
      setSelectedEffort(effort)
      rememberComposerSelection(provider, { modelId: selectedModel, effort })
      void persistThreadSettings({ modelId: selectedModel, effort, collaborationModeId: selectedCollaborationMode })
    },
    [
      persistThreadSettings,
      rememberComposerSelection,
      selectedCollaborationMode,
      selectedModel,
      selectedProvider,
      selectedThread,
    ],
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
      const preferredSelection = selectionForWorkspace(
        persistedComposerSelections,
        selectedWorkspace?.path,
        provider,
      )
      setSelectedProvider(provider)
      const fallbackModelId = resolveThreadModelId(
        null,
        selectedWorkspace,
        preferredSelection?.modelId,
        provider,
      )
      setSelectedModel(fallbackModelId)
      setSelectedEffort(
        resolveReasoningEffort(
          null,
          selectedWorkspace,
          fallbackModelId,
          preferredSelection?.effort,
          provider,
        ) ?? 'medium',
      )
      setSelectedCollaborationMode(null)
    },
    [persistedComposerSelections, selectedThread, selectedWorkspace],
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
    const submittedSkills = selectedSkillsFromText(submittedDraft, selectedWorkspace.skills ?? [])
    const activeProvider = selectedThread?.provider ?? selectedProvider
    const blockReason = workspaceSendBlockReason(selectedWorkspace, activeProvider)
    if (blockReason) {
      setActionError(blockReason)
      toast({ variant: 'danger', title: 'Project not ready', description: blockReason })
      return
    }
    setDraft('')
    setAttachments([])
    setIsSending(true)
    try {
      let activeThreadId = selectedThreadId
      if (!activeThreadId) {
        const handle = await api.startThread({
          workspace_id: selectedWorkspace.id,
          provider: activeProvider,
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
        selected_skills: submittedSkills,
        provider: activeProvider,
        model_id: selectedModel,
        reasoning_effort: selectedEffort,
        collaboration_mode_id: selectedCollaborationMode,
        approval_policy: 'on-request',
      })
      setActionError(null)
    } catch (error) {
      setDraft(submittedDraft)
      setAttachments(submittedAttachments)
      const rawMessage = error instanceof Error ? error.message : 'Failed to send turn'
      const msg = normalizeSendError(rawMessage, activeProvider)
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
  }, [
    api,
    selectedWorkspace,
    selectedThread,
    selectedThreadId,
    selectedProvider,
    draft,
    attachments,
    selectedModel,
    selectedEffort,
    selectedCollaborationMode,
  ])

  const handlePickImages = useCallback(
    (files: FileList | null) => {
      void filesToImageInputs(files).then((next) => setAttachments((c) => [...c, ...next]))
    },
    [],
  )

  const handleRemoveAttachment = useCallback((attachmentId: string) => {
    setAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId))
  }, [])

  const handleStartPairingCallback = useCallback(() => {
    void handleStartRemotePairing()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, relayUrl])

  const handleRefreshRemoteStatus = useCallback(() => {
    if (!api) return
    void api.remoteStatus().then(setRemoteStatus).catch(() => {})
  }, [api, setRemoteStatus])

  const handleUpdatePreferences = useCallback(
    async (payload: UpdatePreferencesPayload) => {
      if (!api) return
      try {
        const preferences = await api.updatePreferences(payload)
        setSnapshot((current) => (current ? { ...current, preferences } : current))
        setActionError(null)
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Failed to update preferences'
        setActionError(msg)
        toast({ variant: 'danger', title: 'Failed to save preferences', description: msg })
      }
    },
    [api, setSnapshot, toast],
  )

  const handleOpenSettings = useCallback(() => {
    setIsSettingsOpen(true)
  }, [])

  const handleCheckForUpdates = useCallback(() => {
    void updater.checkForUpdates({ manual: true }).then((result) => {
      if (result.kind === 'upToDate') {
        toast({
          variant: 'success',
          title: 'FalconDeck is up to date',
          description: 'No newer stable desktop release is available right now.',
        })
      } else if (result.kind === 'unsupported') {
        toast({
          variant: 'default',
          title: 'Updater unavailable',
          description: result.message,
        })
      } else if (result.kind === 'error') {
        toast({
          variant: 'danger',
          title: 'Update check failed',
          description: result.message,
        })
      }
    })
  }, [toast, updater])

  const handleDownloadUpdate = useCallback(() => {
    void updater.downloadAndInstall().catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : 'Failed to download the update'
      toast({ variant: 'danger', title: 'Update download failed', description: msg })
    })
  }, [toast, updater])

  const handleRestartToInstallUpdate = useCallback(() => {
    void updater.restartToInstall().catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : 'Failed to restart FalconDeck'
      toast({ variant: 'danger', title: 'Restart failed', description: msg })
    })
  }, [toast, updater])

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
  const activeProvider = selectedThread?.provider ?? selectedProvider
  const currentReasoningOptions = useMemo(
    () =>
      reasoningOptions(
        selectedThread,
        selectedWorkspace,
        selectedModel,
        activeProvider,
      ),
    [activeProvider, selectedModel, selectedThread, selectedWorkspace],
  )
  const models = useMemo(
    () => workspaceModels(selectedWorkspace, activeProvider),
    [activeProvider, selectedWorkspace],
  )
  const collaborationModes = useMemo(
    () => workspaceCollaborationModes(selectedWorkspace, activeProvider),
    [activeProvider, selectedWorkspace],
  )
  const showPlanModeToggle = useMemo(
    () => supportsPlanMode(selectedWorkspace, activeProvider),
    [activeProvider, selectedWorkspace],
  )
  const planModeEnabled = useMemo(
    () => isPlanModeEnabled(selectedCollaborationMode, selectedWorkspace, activeProvider),
    [activeProvider, selectedCollaborationMode, selectedWorkspace],
  )
  const sendBlockReason = workspaceSendBlockReason(selectedWorkspace, activeProvider)
  const isDisabled = !selectedWorkspace || isSending || Boolean(sendBlockReason)
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
              preferences={snapshot?.preferences ?? null}
              remoteStatus={remoteStatus}
              pairingLink={pairingLink}
              relayUrl={relayUrl}
              isStartingRemote={isStartingRemote}
              revokingDeviceId={revokingDeviceId}
              updater={updater.state}
              updaterProgressPercent={updater.progressPercent}
              onUpdatePreferences={handleUpdatePreferences}
              onStartPairing={handleStartPairingCallback}
              onRefreshRemoteStatus={handleRefreshRemoteStatus}
              onRevokeDevice={handleRevokeDevice}
              onCheckForUpdates={handleCheckForUpdates}
              onDownloadUpdate={handleDownloadUpdate}
              onRestartToInstallUpdate={handleRestartToInstallUpdate}
              onClose={() => setIsSettingsOpen(false)}
            />
          ) : (
            <DesktopConversationPane
              selectedWorkspace={selectedWorkspace}
              selectedThread={selectedThread}
              selectedWorkspaceId={selectedWorkspaceId}
              selectedThreadId={selectedThreadId}
              remoteStatus={remoteStatus}
              pairingLink={pairingLink}
              isStartingRemote={isStartingRemote}
              conversationItems={conversationItems}
              preferences={snapshot?.preferences ?? null}
              conversationEmptyState={conversationEmptyState}
              isSending={isSending}
              isThreadDetailPending={isThreadDetailPending}
              interactiveRequests={interactiveRequests}
              onStartPairing={handleStartPairingCallback}
              onRefreshRemoteStatus={handleRefreshRemoteStatus}
              onInteractiveResponse={handleInteractiveResponseCallback}
              promptInputProps={{
                value: draft,
                onValueChange: setDraft,
                onSubmit: handleSubmitCallback,
                onPickImages: handlePickImages,
                onRemoveAttachment: handleRemoveAttachment,
                attachments,
                skills: selectedWorkspace?.skills ?? [],
                selectedProvider,
                onProviderChange: handleProviderChange,
                providerLocked: Boolean(selectedThread),
                showProviderSelector: !selectedThread,
                models,
                selectedModelId: selectedModel,
                onModelChange: handleModelChange,
                reasoningOptions: currentReasoningOptions,
                selectedEffort,
                onEffortChange: handleEffortChange,
                collaborationModes,
                selectedCollaborationModeId: selectedCollaborationMode,
                onCollaborationModeChange: handleCollaborationModeChange,
                showPlanModeToggle,
                planModeEnabled,
                onPlanModeChange: (enabled) =>
                  handleCollaborationModeChange(
                    togglePlanMode(enabled, selectedWorkspace, selectedCollaborationMode, activeProvider),
                  ),
                disabled: isDisabled,
              }}
            />
          )
        }
        rail={
          isSettingsOpen
            ? undefined
            : <DiffPanel api={api} workspaceId={selectedWorkspaceId} refreshTrigger={gitRefreshTrigger} />
        }
      />
      {isImportingProjectSessions ? <ProjectImportOverlay /> : null}
    </>
  )
}

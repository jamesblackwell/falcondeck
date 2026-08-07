import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  buildProjectGroups,
  countAwaitingResponseThreads,
  conversationItemsForSelection,
  deriveThreadAttentionPresentation,
  filesToImageInputs,
  providerForThread,
  selectedSkillsFromText,
  workspaceAgentCapabilities,
  workspaceModels,
  workspaceProviderOptions,
  type AgentProvider,
  type ConversationItem,
  type ImageInput,
  type InteractiveRequest,
  type InteractiveResponsePayload,
  type ThreadHandle,
  type ThreadIsolation,
  type ThinkingDisplay,
  type ThreadSummary,
  type TurnInputItem,
  type UpdatePreferencesPayload,
} from '@falcondeck/client-core'
import { CommandPalette, GoalControl, NewThreadState } from '@falcondeck/chat-ui'
import { Button, ToastProvider, useToast } from '@falcondeck/ui'
import { LoaderCircle } from 'lucide-react'

import {
  markInteractiveRequestResolved,
  normalizeSendError,
  workspaceComposerDisabled,
  workspaceSendBlockReason,
} from './app-utils'
import {
  preferencesWithThinkingDisplay,
  readStoredThinkingDisplay,
  splitPreferencesUpdate,
  writeStoredThinkingDisplay,
} from './preferences'
import {
  defaultReasoningEffort,
  reasoningOptions,
  resolveReasoningEffort,
  resolveThreadModelId,
} from './utils'
import { DesktopConversationPane } from './components/DesktopConversationPane'
import { DesktopSidebar } from './components/Sidebar'
import { DesktopShell } from './components/DesktopShell'
import { DiffPanel, type DiffPanelSelection } from './components/DiffPanel'
import { PanelToggles } from './components/PanelToggles'
import { ProjectImportOverlay } from './components/ProjectImportOverlay'
import { SettingsView } from './components/SettingsView'
import type { SettingsSectionId } from './components/settings/settings-utils'
import { useAppUpdater } from './hooks/useAppUpdater'
import { useDaemonConnection } from './hooks/useDaemonConnection'
import { usePanelVisibility } from './hooks/usePanelVisibility'
import { useRemoteHosts } from './hooks/useRemoteHosts'
import { hostLabelByWorkspaceId, mergeSnapshots } from './hosts'

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
  const remoteHosts = useRemoteHosts()
  const hostSnapshots = useMemo(
    () => remoteHosts.hosts.map((host) => host.snapshot),
    [remoteHosts.hosts],
  )
  const {
    api,
    baseUrl,
    connectionError,
    snapshot,
    setSnapshot,
    threadDetail,
    setThreadDetail,
    threadDetailError,
    retryThreadDetail,
    remoteStatus,
    setRemoteStatus,
    selectedWorkspaceId,
    setSelectedWorkspaceId,
    selectedThreadId,
    setSelectedThreadId,
    gitRefreshTrigger,
  } = useDaemonConnection({ externalSnapshots: hostSnapshots })
  const updater = useAppUpdater()
  const { sidebarVisible, railVisible, toggleSidebar, toggleRail, showRail } = usePanelVisibility()

  const [draft, setDraft] = useState('')
  const [relayUrl] = useState(
    import.meta.env.VITE_FALCONDECK_RELAY_URL ?? 'https://connect.falcondeck.com',
  )
  const [attachments, setAttachments] = useState<ImageInput[]>([])
  const [selectedProvider, setSelectedProvider] = useState<AgentProvider>('codex')
  const [selectedModel, setSelectedModel] = useState<string | null>(null)
  const [selectedEffort, setSelectedEffort] = useState<string | null>('medium')
  const [selectedPermissionMode, setSelectedPermissionMode] = useState<string | null>(null)
  const [selectedSandboxMode, setSelectedSandboxMode] = useState<string | null>(null)
  // Only ever applies to the next thread this composer creates; a thread's
  // working directory cannot change after it exists.
  const [selectedIsolation, setSelectedIsolation] = useState<ThreadIsolation>('project_folder')
  const [persistedComposerSelections, setPersistedComposerSelections] =
    useState<PersistedComposerSelections>(() => readPersistedComposerSelections())
  const [isAddingProject, setIsAddingProject] = useState(false)
  const [isImportingProjectSessions, setIsImportingProjectSessions] = useState(false)
  const [isStartingRemote, setIsStartingRemote] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId>('general')
  const [diffSelection, setDiffSelection] = useState<DiffPanelSelection | null>(null)
  const [isSending, setIsSending] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [revokingDeviceId, setRevokingDeviceId] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [windowFocused, setWindowFocused] = useState(() => document.visibilityState !== 'hidden')
  const [thinkingDisplay, setThinkingDisplay] = useState<ThinkingDisplay>(readStoredThinkingDisplay)
  const selectionSeedRef = useRef<string | null>(null)
  const threadSettingsRequestRef = useRef(0)
  const notifiedAttentionRef = useRef(new Map<string, string>())
  const announcedUpdateVersionRef = useRef<string | null>(null)
  const announcedDownloadedVersionRef = useRef<string | null>(null)

  // Local daemon snapshot merged with enrolled remote-host snapshots: the
  // sidebar, selection, and composer all see one world; writes route back to
  // the owning daemon via apiFor.
  const viewSnapshot = useMemo(
    () => mergeSnapshots(snapshot, remoteHosts.hosts),
    [remoteHosts.hosts, snapshot],
  )
  const workspaceHostIndex = useMemo(
    () => hostLabelByWorkspaceId(remoteHosts.hosts),
    [remoteHosts.hosts],
  )
  const workspaceHostBadges = useMemo(() => {
    const badges: Record<string, { name: string; connected: boolean }> = {}
    for (const [workspaceId, host] of workspaceHostIndex) {
      badges[workspaceId] = {
        name: host.name,
        connected: host.status === 'encrypted' && (host.presence?.daemon_connected ?? false),
      }
    }
    return badges
  }, [workspaceHostIndex])
  const apiFor = useCallback(
    (workspaceId: string | null | undefined) => {
      const host = remoteHosts.hostForWorkspace(workspaceId)
      return host ? host.api() : api
    },
    [api, remoteHosts.hostForWorkspace],
  )
  const selectedWorkspace = useMemo(
    () => viewSnapshot?.workspaces.find((w) => w.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, viewSnapshot?.workspaces],
  )
  // Enabled MCP servers usable by the selected local workspace's agents; feeds
  // the composer's tools chip. Re-fetched when settings close so panel edits
  // show up. Depends on scalar keys only — object/map identities churn per
  // render and would turn every keystroke into a connector fetch.
  const [connectorCount, setConnectorCount] = useState(0)
  const isRemoteWorkspaceSelected = workspaceHostIndex.has(selectedWorkspaceId ?? '')

  // A file named in the transcript opens in the changes rail. There is no
  // per-item diff endpoint, so this shows the file's *current* working-tree
  // diff, which is the same view the rail's own file list gives.
  const handleOpenFileDiff = useCallback(
    (filePath: string) => {
      if (!selectedWorkspaceId) return
      setDiffSelection({ workspaceId: selectedWorkspaceId, filePath })
      showRail()
    },
    [selectedWorkspaceId, showRail],
  )
  const workspaceProviderIds = (selectedWorkspace?.agents ?? [])
    .map((agent) => agent.provider)
    .sort()
    .join(',')
  useEffect(() => {
    if (!baseUrl || !selectedWorkspaceId || isRemoteWorkspaceSelected) {
      setConnectorCount(0)
      return
    }
    if (isSettingsOpen) return
    const workspaceProviders = new Set(workspaceProviderIds.split(',').filter(Boolean))
    let cancelled = false
    void fetch(`${baseUrl}/api/connectors?workspace_id=${encodeURIComponent(selectedWorkspaceId)}`)
      .then(async (response) => (response.ok ? response.json() : null))
      .then((overview: { merged?: Array<{ enabled?: boolean; providers?: string[] }> } | null) => {
        if (cancelled) return
        setConnectorCount(
          overview?.merged?.filter(
            (entry) =>
              entry.enabled !== false &&
              (!entry.providers?.length ||
                entry.providers.some((provider) => workspaceProviders.has(provider))),
          ).length ?? 0,
        )
      })
      .catch(() => {
        if (!cancelled) setConnectorCount(0)
      })
    return () => {
      cancelled = true
    }
  }, [baseUrl, selectedWorkspaceId, isRemoteWorkspaceSelected, isSettingsOpen, workspaceProviderIds])
  const selectedThread = useMemo(
    () => viewSnapshot?.threads.find((t) => t.id === selectedThreadId) ?? null,
    [selectedThreadId, viewSnapshot?.threads],
  )
  const groups = useMemo(
    () => buildProjectGroups(viewSnapshot?.workspaces ?? [], viewSnapshot?.threads ?? []),
    [viewSnapshot?.threads, viewSnapshot?.workspaces],
  )
  const interactiveRequests = useMemo(
    () =>
      selectedThreadId
        ? (viewSnapshot?.interactive_requests ?? []).filter(
            (request) => request.thread_id === selectedThreadId,
          )
        : [],
    [selectedThreadId, viewSnapshot?.interactive_requests],
  )
  const remoteWebUrl = import.meta.env.VITE_FALCONDECK_REMOTE_WEB_URL ?? 'https://app.falcondeck.com'
  const defaultRelayUrl = 'https://connect.falcondeck.com'
  const remoteControlsUnavailableReason = connectionError ?? 'FalconDeck is still connecting to the local daemon.'
  const remoteControlsDisabled = !api
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
      setSelectedPermissionMode(null)
      setSelectedSandboxMode(null)
      setSelectedIsolation('project_folder')
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
    setSelectedPermissionMode(selectedThread?.agent.permission_mode ?? null)
    setSelectedSandboxMode(selectedThread?.agent.sandbox_mode ?? null)
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

  // Load and keep fresh the thread detail for remote-host selections. Fetch
  // once per selection; on every host notification re-read the cache so
  // streaming updates applied by the host connection reach the open thread.
  const remoteDetailFetchedRef = useRef<string | null>(null)
  useEffect(() => {
    const host = remoteHosts.hostForWorkspace(selectedWorkspaceId)
    if (!host || !selectedWorkspaceId || !selectedThreadId) {
      remoteDetailFetchedRef.current = null
      return
    }
    const key = `${selectedWorkspaceId}:${selectedThreadId}`
    const cached = host.cachedThreadDetail(selectedWorkspaceId, selectedThreadId)
    if (cached) {
      setThreadDetail((current) => (current === cached ? current : cached))
    }
    if (remoteDetailFetchedRef.current === key) return
    remoteDetailFetchedRef.current = key
    if (!cached) setThreadDetail(null)
    let cancelled = false
    void host
      .threadDetail(selectedWorkspaceId, selectedThreadId)
      .then((detail) => {
        if (!cancelled) setThreadDetail(detail)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        const msg = error instanceof Error ? error.message : 'Failed to load remote thread'
        setActionError(msg)
      })
    return () => {
      cancelled = true
    }
  }, [remoteHosts.hosts, remoteHosts.hostForWorkspace, selectedThreadId, selectedWorkspaceId, setThreadDetail])

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
    const client = apiFor(selectedWorkspaceId)
    if (!client || !selectedWorkspaceId || !selectedThread) return
    if (!windowFocused) return
    const readSeq = selectedThread.attention.last_agent_activity_seq
    if (!readSeq || readSeq <= selectedThread.attention.last_read_seq) return

    void client
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
  }, [apiFor, selectedThread, selectedWorkspaceId, setSnapshot, windowFocused])

  useEffect(() => {
    const count = countAwaitingResponseThreads(viewSnapshot?.threads ?? [])
    document.title = count > 0 ? `(${count}) FalconDeck` : 'FalconDeck'

    if (!window.__TAURI_INTERNALS__) return
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().setBadgeCount(count || undefined))
      .catch(() => {})
  }, [viewSnapshot?.threads])

  useEffect(() => {
    if (!viewSnapshot?.threads?.length) return

    for (const thread of viewSnapshot.threads) {
      const attention = deriveThreadAttentionPresentation(thread, viewSnapshot.interactive_requests)
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
  }, [selectedThreadId, viewSnapshot?.interactive_requests, viewSnapshot?.threads, windowFocused])

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
    }: {
      modelId: string | null
      effort: string | null
    }) => {
      const client = apiFor(selectedWorkspace?.id)
      if (!client || !selectedWorkspace || !selectedThreadId) return
      const requestId = ++threadSettingsRequestRef.current
      try {
        const handle = await client.updateThread({
          workspace_id: selectedWorkspace.id,
          thread_id: selectedThreadId,
          provider: selectedThread?.provider ?? selectedProvider,
          model_id: modelId,
          reasoning_effort: effort,
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
    [apiFor, applyThreadHandle, selectedProvider, selectedThread, selectedThreadId, selectedWorkspace, toast],
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
      void persistThreadSettings({ modelId, effort: nextEffort })
    },
    [
      persistThreadSettings,
      rememberComposerSelection,
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
      void persistThreadSettings({ modelId: selectedModel, effort })
    },
    [
      persistThreadSettings,
      rememberComposerSelection,
      selectedModel,
      selectedProvider,
      selectedThread,
    ],
  )

  const handlePermissionModeChange = useCallback(
    (mode: string | null) => {
      setSelectedPermissionMode(mode)
      const client = apiFor(selectedWorkspace?.id)
      if (!client || !selectedWorkspace || !selectedThreadId) return
      void client
        .updateThread({
          workspace_id: selectedWorkspace.id,
          thread_id: selectedThreadId,
          permission_mode: mode,
        })
        .then(applyThreadHandle)
        .catch((error: unknown) => {
          const msg = error instanceof Error ? error.message : 'Failed to update permission mode'
          setActionError(msg)
        })
    },
    [apiFor, applyThreadHandle, selectedThreadId, selectedWorkspace, setActionError],
  )

  const handleSandboxModeChange = useCallback(
    (mode: string | null) => {
      setSelectedSandboxMode(mode)
      const client = apiFor(selectedWorkspace?.id)
      if (!client || !selectedWorkspace || !selectedThreadId) return
      void client
        .updateThread({
          workspace_id: selectedWorkspace.id,
          thread_id: selectedThreadId,
          sandbox_mode: mode,
        })
        .then(applyThreadHandle)
        .catch((error: unknown) => {
          const msg = error instanceof Error ? error.message : 'Failed to update sandbox mode'
          setActionError(msg)
        })
    },
    [apiFor, applyThreadHandle, selectedThreadId, selectedWorkspace, setActionError],
  )

  const applyThreadSummary = useCallback(
    (thread: ThreadSummary) => {
      setSnapshot((current) =>
        current
          ? {
              ...current,
              threads: current.threads.map((entry) => (entry.id === thread.id ? thread : entry)),
            }
          : current,
      )
    },
    [setSnapshot],
  )

  const handleSetGoal = useCallback(
    async (objective: string, tokenBudget: number | null) => {
      const client = apiFor(selectedWorkspace?.id)
      if (!client || !selectedWorkspace || !selectedThreadId) {
        throw new Error('Select a thread first')
      }
      const thread = await client.setThreadGoal({
        workspace_id: selectedWorkspace.id,
        thread_id: selectedThreadId,
        objective,
        token_budget: tokenBudget,
      })
      applyThreadSummary(thread)
    },
    [apiFor, applyThreadSummary, selectedThreadId, selectedWorkspace],
  )

  const handleClearGoal = useCallback(async () => {
    const client = apiFor(selectedWorkspace?.id)
    if (!client || !selectedWorkspace || !selectedThreadId) return
    const thread = await client.clearThreadGoal(selectedWorkspace.id, selectedThreadId)
    applyThreadSummary(thread)
  }, [apiFor, applyThreadSummary, selectedThreadId, selectedWorkspace])

  const handleSetGoalStatus = useCallback(
    async (status: 'active' | 'paused') => {
      const client = apiFor(selectedWorkspace?.id)
      if (!client || !selectedWorkspace || !selectedThreadId) return
      const thread = await client.setThreadGoal({
        workspace_id: selectedWorkspace.id,
        thread_id: selectedThreadId,
        status,
      })
      applyThreadSummary(thread)
    },
    [apiFor, applyThreadSummary, selectedThreadId, selectedWorkspace],
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
      setSelectedPermissionMode(null)
      setSelectedSandboxMode(null)
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

  const handleRemoveWorkspace = useCallback(
    async (workspaceId: string) => {
      const client = apiFor(workspaceId)
      if (!client) return
      await client.removeWorkspace(workspaceId)
      if (!workspaceHostIndex.has(workspaceId) && api) {
        const nextSnapshot = await api.snapshot()
        setSnapshot(nextSnapshot)
      }
      if (selectedWorkspaceId === workspaceId) {
        setSelectedWorkspaceId(null)
        setSelectedThreadId(null)
        setThreadDetail(null)
      }
      setActionError(null)
    },
    [
      api,
      apiFor,
      selectedWorkspaceId,
      setActionError,
      setSelectedThreadId,
      setSelectedWorkspaceId,
      setSnapshot,
      setThreadDetail,
      workspaceHostIndex,
    ],
  )

  async function handleStop() {
    const client = apiFor(selectedWorkspace?.id)
    if (!client || !selectedWorkspace || !selectedThreadId) return
    if (selectedThread?.status !== 'running') return
    setIsStopping(true)
    try {
      await client.interruptTurn(selectedWorkspace.id, selectedThreadId)
      setActionError(null)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to stop turn'
      setActionError(msg)
      toast({ variant: 'danger', title: 'Failed to stop', description: msg })
    } finally {
      setIsStopping(false)
    }
  }

  async function handleSubmit() {
    const client = apiFor(selectedWorkspace?.id)
    if (!client || !selectedWorkspace || (!draft.trim() && attachments.length === 0)) return
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
        const handle = await client.startThread({
          workspace_id: selectedWorkspace.id,
          provider: activeProvider,
          model_id: selectedModel,
          approval_policy: 'on-request',
          permission_mode: selectedPermissionMode,
          sandbox_mode: selectedSandboxMode,
          isolation: selectedIsolation,
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
      await client.sendTurn({
        workspace_id: selectedWorkspace.id,
        thread_id: activeThreadId,
        inputs,
        selected_skills: submittedSkills,
        provider: activeProvider,
        model_id: selectedModel,
        reasoning_effort: selectedEffort,
        approval_policy: 'on-request',
        permission_mode: selectedPermissionMode,
        sandbox_mode: selectedSandboxMode,
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
    if (!api) {
      setActionError(remoteControlsUnavailableReason)
      toast({
        variant: 'danger',
        title: 'FalconDeck is not ready yet',
        description: remoteControlsUnavailableReason,
      })
      return
    }
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
    const client = apiFor(workspaceId)
    if (!client) return
    const isRemoteWorkspace = workspaceHostIndex.has(workspaceId)
    try {
      await client.respondInteractive(workspaceId, requestId, response)
      setThreadDetail((current) =>
        current && current.workspace.id === workspaceId
          ? {
              ...current,
              items: markInteractiveRequestResolved(current.items, requestId),
            }
          : current,
      )
      // Remote host snapshots refresh through their event streams; only the
      // local daemon needs the explicit refetch.
      if (!isRemoteWorkspace && api) {
        const nextSnapshot = await api.snapshot()
        setSnapshot(nextSnapshot)
      }
      setActionError(null)
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Failed to respond to request'
      setActionError(msg)
      toast({ variant: 'danger', title: 'Failed to respond', description: msg })
      // Rethrown so the request card can show the failure where the user
      // clicked, instead of only in a toast that scrolls away.
      throw error instanceof Error ? error : new Error(msg)
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
    (request: InteractiveRequest, response: InteractiveResponsePayload) =>
      handleInteractiveResponse(request.workspace_id, request.request_id, response),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, apiFor, workspaceHostIndex],
  )

  const handleStopCallback = useCallback(() => {
    void handleStop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    apiFor,
    selectedWorkspace,
    selectedThread,
    selectedThreadId,
    setActionError,
    toast,
  ])

  const handleSubmitCallback = useCallback(() => {
    void handleSubmit()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    api,
    apiFor,
    selectedWorkspace,
    selectedThread,
    selectedThreadId,
    selectedProvider,
    draft,
    attachments,
    selectedModel,
    selectedEffort,
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
    if (!api) {
      setActionError(remoteControlsUnavailableReason)
      toast({
        variant: 'danger',
        title: 'FalconDeck is not ready yet',
        description: remoteControlsUnavailableReason,
      })
      return
    }

    void api.remoteStatus().then((nextStatus) => {
      setRemoteStatus(nextStatus)
      setActionError(null)
    }).catch((error) => {
      const msg = error instanceof Error ? error.message : 'Failed to refresh remote status'
      setActionError(msg)
      toast({ variant: 'danger', title: 'Failed to refresh remote status', description: msg })
    })
  }, [api, remoteControlsUnavailableReason, setRemoteStatus, toast])

  const handleUpdatePreferences = useCallback(
    async (payload: UpdatePreferencesPayload) => {
      const { daemonPayload, thinkingDisplay: nextThinkingDisplay } =
        splitPreferencesUpdate(payload)
      if (nextThinkingDisplay) {
        setThinkingDisplay(nextThinkingDisplay)
        writeStoredThinkingDisplay(nextThinkingDisplay)
      }
      if (!daemonPayload) return
      if (!api) return
      try {
        const preferences = await api.updatePreferences(daemonPayload)
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
    setSettingsSection('general')
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

  const handleRemoveQueuedTurn = useCallback(
    async (queuedId: string) => {
      if (!selectedWorkspaceId || !selectedThreadId) return
      const client = apiFor(selectedWorkspaceId)
      if (!client) return
      try {
        await client.removeQueuedTurn(selectedWorkspaceId, selectedThreadId, queuedId)
        if (!workspaceHostIndex.has(selectedWorkspaceId) && api) {
          setSnapshot(await api.snapshot())
        }
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to remove queued message'
        toast({ variant: 'danger', title: 'Failed to remove queued message', description: msg })
      }
    },
    [api, apiFor, selectedThreadId, selectedWorkspaceId, setSnapshot, toast, workspaceHostIndex],
  )

  const handleSteerQueuedTurn = useCallback(
    async (queuedId: string) => {
      if (!selectedWorkspaceId || !selectedThreadId) return
      const client = apiFor(selectedWorkspaceId)
      if (!client) return
      try {
        await client.steerQueuedTurn(selectedWorkspaceId, selectedThreadId, queuedId)
        if (!workspaceHostIndex.has(selectedWorkspaceId) && api) {
          setSnapshot(await api.snapshot())
        }
      } catch (error: unknown) {
        // The daemon keeps the message queued when a steer fails, so the chip
        // the user acted on is still there when they read this.
        const msg = error instanceof Error ? error.message : 'Failed to steer queued message'
        toast({ variant: 'danger', title: 'Failed to steer queued message', description: msg })
      }
    },
    [api, apiFor, selectedThreadId, selectedWorkspaceId, setSnapshot, toast, workspaceHostIndex],
  )

  const handleArchiveThread = useCallback(
    async (workspaceId: string, threadId: string) => {
      const client = apiFor(workspaceId)
      if (!client) throw new Error('FalconDeck is still connecting')
      try {
        await client.archiveThread(workspaceId, threadId)
        if (selectedThreadId === threadId) {
          setSelectedThreadId(null)
        }
        if (!workspaceHostIndex.has(workspaceId) && api) {
          const nextSnapshot = await api.snapshot()
          setSnapshot(nextSnapshot)
        }
        setActionError(null)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to archive thread'
        setActionError(msg)
        toast({ variant: 'danger', title: 'Failed to archive thread', description: msg })
      }
    },
    [api, apiFor, selectedThreadId, setActionError, setSelectedThreadId, setSnapshot, toast, workspaceHostIndex],
  )

  const handleDeleteThread = useCallback(
    async (workspaceId: string, threadId: string) => {
      const client = apiFor(workspaceId)
      if (!client) throw new Error('FalconDeck is still connecting')
      try {
        await client.deleteThread(workspaceId, threadId)
        if (selectedThreadId === threadId) {
          setSelectedThreadId(null)
          setThreadDetail(null)
        }
        if (!workspaceHostIndex.has(workspaceId) && api) {
          setSnapshot(await api.snapshot())
        }
        setActionError(null)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to delete thread'
        setActionError(msg)
        toast({ variant: 'danger', title: 'Failed to delete thread', description: msg })
        // Rethrown so the dialog keeps itself open and shows the reason.
        throw error instanceof Error ? error : new Error(msg)
      }
    },
    [
      api,
      apiFor,
      selectedThreadId,
      setActionError,
      setSelectedThreadId,
      setSnapshot,
      setThreadDetail,
      toast,
      workspaceHostIndex,
    ],
  )

  const handleRenameThread = useCallback(
    async (workspaceId: string, threadId: string, title: string) => {
      const client = apiFor(workspaceId)
      if (!client) throw new Error('FalconDeck is still connecting')
      try {
        const handle = await client.updateThread({
          workspace_id: workspaceId,
          thread_id: threadId,
          title,
        })
        applyThreadHandle(handle)
        setActionError(null)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to rename thread'
        setActionError(msg)
        toast({ variant: 'danger', title: 'Failed to rename thread', description: msg })
        throw error instanceof Error ? error : new Error(msg)
      }
    },
    [apiFor, applyThreadHandle, setActionError, toast],
  )

  const handleTogglePinThread = useCallback(
    async (workspaceId: string, threadId: string, pinned: boolean) => {
      const client = apiFor(workspaceId)
      if (!client) throw new Error('FalconDeck is still connecting')
      try {
        const handle = await client.updateThread({
          workspace_id: workspaceId,
          thread_id: threadId,
          pinned,
        })
        applyThreadHandle(handle)
        setActionError(null)
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to update pin'
        setActionError(msg)
        toast({ variant: 'danger', title: 'Failed to update pin', description: msg })
      }
    },
    [apiFor, applyThreadHandle, setActionError, toast],
  )

  const handleMarkThreadRead = useCallback(
    async (workspaceId: string, threadId: string) => {
      const client = apiFor(workspaceId)
      if (!client) return
      const thread = viewSnapshot?.threads.find(
        (entry) => entry.workspace_id === workspaceId && entry.id === threadId,
      )
      const readSeq = thread?.attention.last_agent_activity_seq ?? 0
      try {
        const updated = await client.markThreadRead({
          workspace_id: workspaceId,
          thread_id: threadId,
          read_seq: readSeq,
        })
        setSnapshot((current) =>
          current
            ? {
                ...current,
                threads: current.threads.map((entry) =>
                  entry.id === updated.id ? updated : entry,
                ),
              }
            : current,
        )
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : 'Failed to mark thread as read'
        setActionError(msg)
      }
    },
    [apiFor, setActionError, setSnapshot, viewSnapshot?.threads],
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
  const providerOptions = useMemo(
    () => workspaceProviderOptions(selectedWorkspace),
    [selectedWorkspace],
  )
  const activeCapabilities = useMemo(
    () => workspaceAgentCapabilities(selectedWorkspace, activeProvider),
    [activeProvider, selectedWorkspace],
  )
  const sendBlockReason = workspaceSendBlockReason(selectedWorkspace, activeProvider)
  const isComposerDisabled = isSending || workspaceComposerDisabled(selectedWorkspace)
  const workspaces = useMemo(() => viewSnapshot?.workspaces ?? [], [viewSnapshot?.workspaces])
  const effectivePreferences = useMemo(
    () => preferencesWithThinkingDisplay(snapshot?.preferences ?? null, thinkingDisplay),
    [snapshot?.preferences, thinkingDisplay],
  )

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
  const threadDetailErrorState = useMemo(
    () =>
      threadDetailError ? (
        <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 text-center">
          <p className="text-[length:var(--fd-text-sm)] text-fg-secondary">
            This conversation could not be loaded.
          </p>
          <p className="max-w-md text-[length:var(--fd-text-xs)] text-fg-muted">
            {threadDetailError}
          </p>
          <Button type="button" variant="secondary" size="sm" onClick={retryThreadDetail}>
            Try again
          </Button>
        </div>
      ) : null,
    [retryThreadDetail, threadDetailError],
  )
  const conversationEmptyState = useMemo(() => {
    // Order matters: a failed load also looks "pending", so the error wins.
    if (threadDetailErrorState) {
      return threadDetailErrorState
    }
    if (isThreadDetailPending) {
      return loadingThreadState
    }
    if (selectedThreadId) {
      return undefined
    }
    return newThreadEmptyState
  }, [
    isThreadDetailPending,
    loadingThreadState,
    newThreadEmptyState,
    selectedThreadId,
    threadDetailErrorState,
  ])

  return (
    <>
      <CommandPalette
        groups={groups}
        onSelectThread={handleSelectThread}
        onNewThread={handleNewThread}
        onOpenSettings={handleOpenSettings}
      />
      <DesktopShell
        sidebar={
          <DesktopSidebar
            groups={groups}
            workspaceHosts={workspaceHostBadges}
            selectedWorkspaceId={selectedWorkspaceId}
            selectedThreadId={selectedThreadId}
            onSelectWorkspace={handleSelectWorkspace}
            onSelectThread={handleSelectThread}
            onNewThread={handleNewThread}
            onArchiveThread={handleArchiveThread}
            onDeleteThread={handleDeleteThread}
            onRenameThread={handleRenameThread}
            onTogglePinThread={handleTogglePinThread}
            onMarkThreadRead={handleMarkThreadRead}
            onAddProject={handleAddProject}
            onRemoveWorkspace={handleRemoveWorkspace}
            isAddingProject={isAddingProject}
            onOpenSettings={handleOpenSettings}
            settingsOpen={isSettingsOpen}
            errors={[connectionError, actionError].filter((value): value is string => Boolean(value))}
          />
        }
        main={
          isSettingsOpen ? (
            <SettingsView
              initialSection={settingsSection}
              workspace={selectedWorkspace}
              localWorkspaces={snapshot?.workspaces ?? []}
              baseUrl={baseUrl}
              hostManager={remoteHosts.manager}
              hosts={remoteHosts.hosts}
              onToast={toast}
              preferences={effectivePreferences}
              remoteStatus={remoteStatus}
              pairingLink={pairingLink}
              relayUrl={relayUrl}
              isStartingRemote={isStartingRemote}
              remoteControlsDisabled={remoteControlsDisabled}
              remoteControlsUnavailableReason={remoteControlsUnavailableReason}
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
              remoteControlsDisabled={remoteControlsDisabled}
              remoteControlsUnavailableReason={remoteControlsUnavailableReason}
              conversationItems={conversationItems}
              preferences={effectivePreferences}
              conversationEmptyState={conversationEmptyState}
              isSending={isSending}
              isThreadDetailPending={isThreadDetailPending}
              interactiveRequests={interactiveRequests}
              onRemoveQueuedTurn={handleRemoveQueuedTurn}
              onSteerQueuedTurn={handleSteerQueuedTurn}
              canSteerQueuedTurn={activeCapabilities.supports_steering}
              // Remote-host workspaces have no local checkout, so the rail has
              // no diff to show and file paths stay plain text there.
              onOpenFile={isRemoteWorkspaceSelected ? null : handleOpenFileDiff}
              onStartPairing={handleStartPairingCallback}
              onInteractiveResponse={handleInteractiveResponseCallback}
              promptInputProps={{
                value: draft,
                onValueChange: setDraft,
                onSubmit: handleSubmitCallback,
                onStop: handleStopCallback,
                onPickImages: handlePickImages,
                onRemoveAttachment: handleRemoveAttachment,
                attachments,
                skills: selectedWorkspace?.skills ?? [],
                selectedProvider,
                onProviderChange: handleProviderChange,
                providers: providerOptions,
                capabilities: activeCapabilities,
                providerLocked: Boolean(selectedThread),
                showProviderSelector: !selectedThread,
                models,
                selectedModelId: selectedModel,
                onModelChange: handleModelChange,
                reasoningOptions: currentReasoningOptions,
                selectedEffort,
                onEffortChange: handleEffortChange,
                selectedPermissionMode,
                onPermissionModeChange: handlePermissionModeChange,
                selectedSandboxMode,
                onSandboxModeChange: handleSandboxModeChange,
                selectedIsolation,
                onIsolationChange: selectedThread ? undefined : setSelectedIsolation,
                disabled: isComposerDisabled,
                sendDisabled: Boolean(sendBlockReason),
                isRunning: selectedThread?.status === 'running',
                isStopping,
                connectorCount,
                onConnectorsClick: () => {
                  setSettingsSection('connectors')
                  setIsSettingsOpen(true)
                },
              }}
              headerControls={
                <>
                  {selectedThread && activeCapabilities.supports_goals ? (
                    <GoalControl
                      goal={selectedThread.goal}
                      provider={activeProvider}
                      onSetGoal={handleSetGoal}
                      onClearGoal={handleClearGoal}
                      onSetGoalStatus={handleSetGoalStatus}
                    />
                  ) : null}
                  <PanelToggles
                  sidebarVisible={sidebarVisible}
                  railVisible={railVisible}
                  onToggleSidebar={toggleSidebar}
                  onToggleRail={toggleRail}
                  />
                </>
              }
            />
          )
        }
        rail={
          isSettingsOpen
            ? undefined
            : (
                <DiffPanel
                  // Git status/diff runs against the local daemon; remote-host
                  // workspaces have no local checkout to inspect.
                  api={workspaceHostIndex.has(selectedWorkspaceId ?? '') ? null : api}
                  workspaceId={selectedWorkspaceId}
                  refreshTrigger={gitRefreshTrigger}
                  reviewThreadId={
                    selectedThread && activeCapabilities.supports_review ? selectedThread.id : null
                  }
                  selection={diffSelection}
                  onSelectionChange={setDiffSelection}
                />
              )
        }
        sidebarVisible={sidebarVisible}
        railVisible={railVisible}
      />
      {isImportingProjectSessions ? <ProjectImportOverlay /> : null}
    </>
  )
}

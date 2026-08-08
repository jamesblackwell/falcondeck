import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, AppState, KeyboardAvoidingView, Platform, Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { FlashList } from '@shopify/flash-list'
import { ChevronLeft, Target } from 'lucide-react-native'
import { DrawerActions } from '@react-navigation/native'
import { useNavigation, useRouter } from 'expo-router'
import {
  composerProviderFor,
  composerSelectionFor,
  defaultProvider,
  encryptJson,
  providerForThread,
  resolvePersistedMode,
  workspaceAgentCapabilities,
  workspaceModels,
  workspaceProviderOptions,
  type AgentProvider,
  type ConversationPresentation,
  type ConversationRenderBlock,
  type QueuedTurnSummary,
} from '@falcondeck/client-core'
import { useShallow } from 'zustand/react/shallow'

import {
  useApprovals,
  useRelayStore,
  useSessionStore,
  useSelectedThread,
  useSelectedThreadHistory,
  useSelectedWorkspace,
  useUIStore,
} from '@/store'
import { useSessionActions } from '@/hooks/useSessionActions'
import { useInterruptTurn } from '@/hooks/useInterruptTurn'
import { useThreadActions } from '@/hooks/useThreadActions'
import { useKeyboardVisible } from '@/hooks/useKeyboardVisible'
import { useConversationPresentation } from '@/hooks/useRenderBlocks'
import { useScrollToBottom } from '@/hooks/useScrollToBottom'
import { Button, Text, EmptyState, ErrorBanner } from '@/components/ui'
import {
  ChatInput,
  ApprovalBanner,
  LiveActivityLane,
  MessageRouter,
  GoalBanner,
  GoalSheet,
  JumpToBottomFab,
  QueuedTurns,
  ThinkingIndicator,
} from '@/components/chat'
import { ConnectionHeader } from '@/components/navigation'
import { pickImageInputsFromLibrary } from '@/features/thread/imageInputs'
import { getWorkspaceTitle, shouldShowThinkingIndicator } from '@/features/thread/threadScreen'

const renderBlock = ({ item }: { item: ConversationRenderBlock }) => (
  <MessageRouter item={item} />
)
const keyExtractor = (block: ConversationRenderBlock) => block.id
const EMPTY_QUEUED_TURNS: QueuedTurnSummary[] = []
const getItemType = (block: ConversationRenderBlock) =>
  block.kind === 'tool_summary' || block.kind === 'work_session' ? block.kind : block.item.kind

export default function HomeScreen() {
  const insets = useSafeAreaInsets()
  const { theme } = useUnistyles()
  const navigation = useNavigation()
  const router = useRouter()

  const presentation: ConversationPresentation = useConversationPresentation()
  const blocks = presentation.history_blocks
  const liveActivityGroups = presentation.live_activity_groups
  const approvals = useApprovals()
  const selectedThread = useSelectedThread()
  const selectedThreadHistory = useSelectedThreadHistory()
  const workspace = useSelectedWorkspace()
  const selectedThreadId = useSessionStore((s) => s.selectedThreadId)
  const selectedWorkspaceId = useSessionStore((s) => s.selectedWorkspaceId)
  const snapshot = useSessionStore((s) => s.snapshot)
  const { connectionStatus, error, isEncrypted, machinePresence, relayUrl, sessionId } =
    useRelayStore(
      useShallow((s) => ({
        connectionStatus: s.connectionStatus,
        error: s.error,
        isEncrypted: s.isEncrypted,
        machinePresence: s.machinePresence,
        relayUrl: s.relayUrl,
        sessionId: s.sessionId,
      })),
    )
  const {
    attachments,
    draft,
    isSubmitting,
    persistedComposerSelections,
    selectedEffort,
    selectedModel,
    selectedPermissionMode,
    selectedProvider,
    selectedSandboxMode,
  } = useUIStore(
    useShallow((s) => ({
      attachments: s.attachments,
      draft: s.draft,
      isSubmitting: s.isSubmitting,
      persistedComposerSelections: s.persistedComposerSelections,
      selectedEffort: s.selectedEffort,
      selectedModel: s.selectedModel,
      selectedPermissionMode: s.selectedPermissionMode,
      selectedProvider: s.selectedProvider,
      selectedSandboxMode: s.selectedSandboxMode,
    })),
  )
  const {
    addAttachments,
    rememberComposerSelection,
    rememberWorkspaceProvider,
    setDraft,
    setSelectedModel,
    setSelectedEffort,
    setSelectedPermissionMode,
    setSelectedProvider,
    setSelectedSandboxMode,
    removeAttachment,
  } = useUIStore.getState()
  const { submitTurn, respondApproval, loadThreadDetail } = useSessionActions()
  const interruptTurn = useInterruptTurn()
  const { clearThreadGoal, editQueuedTurn, removeQueuedTurn, setThreadGoal, setThreadMode, steerQueuedTurn } =
    useThreadActions()
  const { listRef, showJumpButton, onScroll, resetScrollState, scrollToBottom } =
    useScrollToBottom<ConversationRenderBlock>()
  const isKeyboardVisible = useKeyboardVisible()
  const [appState, setAppState] = useState(AppState.currentState)
  const [detailLoadingThreadId, setDetailLoadingThreadId] = useState<string | null>(null)
  const [isLoadingOlder, setIsLoadingOlder] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [isGoalSheetOpen, setIsGoalSheetOpen] = useState(false)
  const selectionSeedRef = useRef<string | null>(null)
  const markReadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSentReadSeqRef = useRef<{ threadId: string; readSeq: number } | null>(null)

  // Compute active provider: thread's provider if running, otherwise UI selection or workspace default
  const activeProvider: AgentProvider = selectedThread
    ? selectedThread.provider
    : (selectedProvider ?? defaultProvider(workspace))

  const providerOptions = useMemo(() => workspaceProviderOptions(workspace), [workspace])

  // Which mode pickers the composer shows, and whether a queued message can be
  // steered — both are per-provider, so they change with the active agent.
  const capabilities = useMemo(
    () => workspaceAgentCapabilities(workspace, activeProvider),
    [activeProvider, workspace],
  )
  const queuedTurns = selectedThread?.queued_turns ?? EMPTY_QUEUED_TURNS
  // A goal belongs to a thread, so there is nothing to set one on until one
  // exists — same gate as desktop.
  const showGoalControl = Boolean(selectedThread) && capabilities.supports_goals

  // Filter models by active provider (matches desktop behavior)
  const models = useMemo(
    () => workspaceModels(workspace, activeProvider),
    [activeProvider, workspace],
  )

  // Compute effort options from the selected model's supported_reasoning_efforts
  const resolvedModel = useMemo(() => {
    if (selectedModel) return models.find((m) => m.id === selectedModel) ?? null
    return models.find((m) => m.is_default) ?? models[0] ?? null
  }, [models, selectedModel])

  const effortOptions = useMemo(() => {
    const supported = resolvedModel?.supported_reasoning_efforts.map((e) => e.reasoning_effort) ?? []
    if (supported.length > 0) return supported
    return resolvedModel?.default_reasoning_effort ? [resolvedModel.default_reasoning_effort] : ['medium']
  }, [resolvedModel])
  const isThreadRunning = selectedThread?.status === 'running'
  const showThinking = shouldShowThinkingIndicator(presentation, isThreadRunning)
  const isSelectedThreadLoading = !!selectedThreadId && detailLoadingThreadId === selectedThreadId

  // True during initial sync: session exists but snapshot hasn't loaded yet
  const isSyncing = !!sessionId && !snapshot

  // Seed provider/model/effort/mode from the current workspace selection.
  useEffect(() => {
    if (!workspace) {
      selectionSeedRef.current = null
      setSelectedProvider(null)
      setSelectedModel(null)
      setSelectedEffort('medium')
      setSelectedPermissionMode(null)
      setSelectedSandboxMode(null)
      return
    }

    const seedKey = `${workspace.id}:${selectedThread?.id ?? 'workspace'}`
    if (selectionSeedRef.current === seedKey) return
    selectionSeedRef.current = seedKey

    // An existing thread dictates its own provider; a new conversation starts
    // from the provider the user last picked here, so that choice sticks.
    const stickyProvider = composerProviderFor(persistedComposerSelections, workspace.path)
    const nextProvider =
      !selectedThread &&
      stickyProvider &&
      workspaceProviderOptions(workspace).some((option) => option.provider === stickyProvider)
        ? stickyProvider
        : providerForThread(selectedThread, workspace)
    const preferredSelection = composerSelectionFor(
      persistedComposerSelections,
      workspace.path,
      nextProvider,
    )

    // A thread owns its modes; a new conversation gets the remembered choice
    // as long as the provider still offers it.
    const seededCapabilities = workspaceAgentCapabilities(workspace, nextProvider)
    setSelectedPermissionMode(
      selectedThread
        ? selectedThread.agent.permission_mode ?? null
        : resolvePersistedMode(
            preferredSelection?.permissionMode,
            seededCapabilities.permission_modes,
          ),
    )
    setSelectedSandboxMode(
      selectedThread
        ? selectedThread.agent.sandbox_mode ?? null
        : resolvePersistedMode(preferredSelection?.sandboxMode, seededCapabilities.sandbox_modes),
    )

    setSelectedProvider(nextProvider)
    const providerModels = workspaceModels(workspace, nextProvider)
    const preferredModel =
      preferredSelection?.modelId &&
      providerModels.some((model) => model.id === preferredSelection.modelId)
        ? preferredSelection.modelId
        : null
    const fallbackModel =
      preferredModel ??
      providerModels.find((model) => model.is_default)?.id ??
      providerModels[0]?.id ??
      null

    if (selectedThread) {
      const nextModel = selectedThread.agent.model_id ?? fallbackModel
      const nextModelSummary = nextModel
        ? providerModels.find((model) => model.id === nextModel) ?? null
        : null
      const supportedEfforts =
        nextModelSummary?.supported_reasoning_efforts.map((entry) => entry.reasoning_effort) ?? []
      setSelectedModel(nextModel)
      setSelectedEffort(
        selectedThread.agent.reasoning_effort ??
          nextModelSummary?.default_reasoning_effort ??
          supportedEfforts[0] ??
          'medium',
      )
      return
    }

    const fallbackModelSummary = fallbackModel
      ? providerModels.find((model) => model.id === fallbackModel) ?? null
      : null
    const supportedEfforts =
      fallbackModelSummary?.supported_reasoning_efforts.map((entry) => entry.reasoning_effort) ?? []
    setSelectedModel(fallbackModel)
    setSelectedEffort(
      (preferredSelection?.effort && supportedEfforts.includes(preferredSelection.effort)
        ? preferredSelection.effort
        : null) ??
        fallbackModelSummary?.default_reasoning_effort ??
        supportedEfforts[0] ??
        'medium',
    )
  }, [
    persistedComposerSelections,
    selectedThread,
    setSelectedEffort,
    setSelectedModel,
    setSelectedPermissionMode,
    setSelectedProvider,
    setSelectedSandboxMode,
    workspace,
  ])

  // Reset effort when it's no longer valid for the current model
  useEffect(() => {
    if (effortOptions.length === 0) return
    if (!selectedEffort || !effortOptions.includes(selectedEffort)) {
      const fallback = resolvedModel?.default_reasoning_effort ?? effortOptions[0] ?? 'medium'
      setSelectedEffort(fallback)
    }
  }, [effortOptions, resolvedModel, selectedEffort, setSelectedEffort])

  const handleProviderChange = useCallback(
    (provider: AgentProvider) => {
      if (selectedThread) return // locked
      setSelectedProvider(provider)
      if (workspace) rememberWorkspaceProvider(workspace.path, provider)
      // Swap in the new provider's remembered model/effort/modes rather than
      // resetting; the seed and validity effects clean up anything stale.
      const preferredSelection = composerSelectionFor(
        persistedComposerSelections,
        workspace?.path,
        provider,
      )
      const providerModels = workspaceModels(workspace, provider)
      setSelectedModel(
        preferredSelection?.modelId &&
          providerModels.some((model) => model.id === preferredSelection.modelId)
          ? preferredSelection.modelId
          : null,
      )
      setSelectedEffort(preferredSelection?.effort ?? null)
      const providerCapabilities = workspaceAgentCapabilities(workspace, provider)
      setSelectedPermissionMode(
        resolvePersistedMode(
          preferredSelection?.permissionMode,
          providerCapabilities.permission_modes,
        ),
      )
      setSelectedSandboxMode(
        resolvePersistedMode(preferredSelection?.sandboxMode, providerCapabilities.sandbox_modes),
      )
    },
    [
      persistedComposerSelections,
      rememberWorkspaceProvider,
      selectedThread,
      setSelectedEffort,
      setSelectedModel,
      setSelectedPermissionMode,
      setSelectedProvider,
      setSelectedSandboxMode,
      workspace,
    ],
  )

  const handleModelChange = useCallback(
    (modelId: string | null) => {
      setSelectedModel(modelId)
      if (workspace && modelId) {
        rememberComposerSelection(workspace.path, activeProvider, { modelId })
      }
    },
    [activeProvider, rememberComposerSelection, setSelectedModel, workspace],
  )

  const handleEffortChange = useCallback(
    (effort: string | null) => {
      setSelectedEffort(effort)
      if (workspace && effort) {
        rememberComposerSelection(workspace.path, activeProvider, { effort })
      }
    },
    [activeProvider, rememberComposerSelection, setSelectedEffort, workspace],
  )

  // Local state moves first so the chip responds to the tap; with a thread
  // selected the choice is also persisted, matching desktop. Before the thread
  // exists there is nothing to persist to — submitTurn carries it instead.
  const handlePermissionModeChange = useCallback(
    (mode: string | null) => {
      setSelectedPermissionMode(mode)
      if (workspace) {
        rememberComposerSelection(workspace.path, activeProvider, { permissionMode: mode })
      }
      if (!selectedWorkspaceId || !selectedThreadId) return
      void setThreadMode(selectedWorkspaceId, selectedThreadId, 'permission_mode', mode).catch(
        () => {},
      )
    },
    [
      activeProvider,
      rememberComposerSelection,
      selectedThreadId,
      selectedWorkspaceId,
      setSelectedPermissionMode,
      setThreadMode,
      workspace,
    ],
  )

  const handleSandboxModeChange = useCallback(
    (mode: string | null) => {
      setSelectedSandboxMode(mode)
      if (workspace) {
        rememberComposerSelection(workspace.path, activeProvider, { sandboxMode: mode })
      }
      if (!selectedWorkspaceId || !selectedThreadId) return
      void setThreadMode(selectedWorkspaceId, selectedThreadId, 'sandbox_mode', mode).catch(() => {})
    },
    [
      activeProvider,
      rememberComposerSelection,
      selectedThreadId,
      selectedWorkspaceId,
      setSelectedSandboxMode,
      setThreadMode,
      workspace,
    ],
  )

  const handleRemoveQueuedTurn = useCallback(
    (queuedId: string) => {
      if (!selectedWorkspaceId || !selectedThreadId) return Promise.resolve()
      return removeQueuedTurn(selectedWorkspaceId, selectedThreadId, queuedId)
    },
    [removeQueuedTurn, selectedThreadId, selectedWorkspaceId],
  )

  const handleSteerQueuedTurn = useCallback(
    (queuedId: string) => {
      if (!selectedWorkspaceId || !selectedThreadId) return Promise.resolve()
      return steerQueuedTurn(selectedWorkspaceId, selectedThreadId, queuedId)
    },
    [selectedThreadId, selectedWorkspaceId, steerQueuedTurn],
  )

  const handleEditQueuedTurn = useCallback(
    (queuedId: string, text: string) => {
      if (!selectedWorkspaceId || !selectedThreadId) return Promise.resolve()
      return editQueuedTurn(selectedWorkspaceId, selectedThreadId, queuedId, text)
    },
    [editQueuedTurn, selectedThreadId, selectedWorkspaceId],
  )

  const handleSetGoal = useCallback(
    (objective: string, tokenBudget: number | null) => {
      if (!selectedWorkspaceId || !selectedThreadId) return Promise.resolve()
      return setThreadGoal(selectedWorkspaceId, selectedThreadId, {
        objective,
        token_budget: tokenBudget,
      })
    },
    [selectedThreadId, selectedWorkspaceId, setThreadGoal],
  )

  const handleClearGoal = useCallback(() => {
    if (!selectedWorkspaceId || !selectedThreadId) return Promise.resolve()
    return clearThreadGoal(selectedWorkspaceId, selectedThreadId)
  }, [clearThreadGoal, selectedThreadId, selectedWorkspaceId])

  const handleSetGoalStatus = useCallback(
    (status: 'active' | 'paused') => {
      if (!selectedWorkspaceId || !selectedThreadId) return Promise.resolve()
      return setThreadGoal(selectedWorkspaceId, selectedThreadId, { status })
    },
    [selectedThreadId, selectedWorkspaceId, setThreadGoal],
  )

  const handleDismissError = useCallback(() => {
    useRelayStore.getState()._setError(null)
  }, [])

  const handleOpenDrawer = useCallback(() => {
    navigation.dispatch(DrawerActions.openDrawer())
  }, [navigation])

  const handleOpenSettings = useCallback(() => {
    router.push('/(app)/settings')
  }, [router])

  const handleAllowApproval = useCallback(
    (id: string) => {
      void respondApproval(id, 'allow')
    },
    [respondApproval],
  )

  const handleDenyApproval = useCallback(
    (id: string) => {
      void respondApproval(id, 'deny')
    },
    [respondApproval],
  )

  const handleLoadOlder = useCallback(() => {
    if (!selectedWorkspaceId || !selectedThreadId || isLoadingOlder || !selectedThreadHistory.hasOlder) {
      return
    }

    // maintainVisibleContentPosition keeps the viewport anchored while the
    // older page prepends above it; no scroll bookkeeping needed here.
    setIsLoadingOlder(true)
    void loadThreadDetail(selectedWorkspaceId, selectedThreadId, { older: true }).finally(() => {
      setIsLoadingOlder(false)
    })
  }, [
    isLoadingOlder,
    loadThreadDetail,
    selectedThreadHistory.hasOlder,
    selectedThreadId,
    selectedWorkspaceId,
  ])

  const handlePickImages = useCallback(() => {
    void pickImageInputsFromLibrary()
      .then((pickedAttachments) => {
        if (pickedAttachments.length === 0) return
        addAttachments(pickedAttachments)
        useRelayStore.getState()._setError(null)
      })
      .catch((error) => {
        useRelayStore.getState()._setError(
          error instanceof Error ? error.message : 'Failed to pick images',
        )
      })
  }, [addAttachments])

  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState)
    return () => {
      subscription.remove()
    }
  }, [])

  useEffect(() => {
    if (!selectedWorkspaceId || !selectedThreadId || !isEncrypted) {
      setDetailLoadingThreadId(null)
      setIsLoadingOlder(false)
      useSessionStore.getState().setThreadDetail(null)
      return
    }

    let cancelled = false
    setIsLoadingOlder(false)
    // Read the item count imperatively: subscribing to it would refire this
    // effect (and a full thread.detail RPC) for every streamed item.
    if ((useSessionStore.getState().threadItems[selectedThreadId]?.length ?? 0) === 0) {
      setDetailLoadingThreadId(selectedThreadId)
    }

    void loadThreadDetail(selectedWorkspaceId, selectedThreadId).finally(() => {
      if (cancelled) return
      setDetailLoadingThreadId((current) => (current === selectedThreadId ? null : current))
    })

    return () => {
      cancelled = true
    }
  }, [isEncrypted, loadThreadDetail, selectedThreadId, selectedWorkspaceId])

  // Opening a thread starts at the bottom via the list's
  // startRenderingFromBottom; only the jump-button state needs resetting.
  useEffect(() => {
    resetScrollState()
  }, [resetScrollState, selectedThreadId])

  useEffect(() => {
    // The cleanup below cancels any pending debounce whenever the deps change
    // (or the screen unmounts), so an early return — switching threads,
    // backgrounding, losing encryption — can never let a stale timer mark the
    // previous thread read with captured values.
    if (appState !== 'active' || !workspace || !selectedThread || !sessionId || !isEncrypted) return

    const readSeq = selectedThread.attention.last_agent_activity_seq
    if (!readSeq || readSeq <= selectedThread.attention.last_read_seq) return

    // Streamed events refire this effect long before the summary reflects the
    // send, so suppress duplicates locally and debounce the action itself.
    const lastSent = lastSentReadSeqRef.current
    if (lastSent && lastSent.threadId === selectedThread.id && lastSent.readSeq >= readSeq) return

    const workspaceId = workspace.id
    const threadId = selectedThread.id

    markReadTimerRef.current = setTimeout(() => {
      markReadTimerRef.current = null
      const relay = useRelayStore.getState()
      const clientToken = relay._getClientToken()
      const sessionCrypto = relay._getSessionCrypto()
      if (!clientToken || !sessionCrypto) return

      lastSentReadSeqRef.current = { threadId, readSeq }
      void encryptJson(sessionCrypto.dataKey, {
        workspace_id: workspaceId,
        thread_id: threadId,
        read_seq: readSeq,
      })
        .then((payload) =>
          fetch(`${relayUrl.replace(/\/$/, '')}/v1/sessions/${encodeURIComponent(sessionId)}/actions`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${clientToken}`,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              idempotency_key: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`,
              action_type: 'thread.mark_read',
              payload,
            }),
          }),
        )
        .catch(() => {})
    }, 1_000)

    return () => {
      if (markReadTimerRef.current) {
        clearTimeout(markReadTimerRef.current)
        markReadTimerRef.current = null
      }
    }
  }, [appState, isEncrypted, relayUrl, selectedThread, sessionId, workspace])

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={styles.header}>
        <Pressable
          style={styles.headerLeft}
          onPress={handleOpenDrawer}
          accessibilityRole="button"
          accessibilityLabel={`Project: ${getWorkspaceTitle(workspace?.path)}`}
          accessibilityHint="Opens the project and thread list"
        >
          <ChevronLeft size={18} color={theme.colors.fg.muted} />
          <Text variant="label" color="primary" weight="semibold" numberOfLines={1} style={styles.headerTitle}>
            {getWorkspaceTitle(workspace?.path)}
          </Text>
        </Pressable>
        <View style={styles.headerRight}>
          {showGoalControl ? (
            <Pressable
              onPress={() => setIsGoalSheetOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={
                selectedThread?.goal ? `Goal: ${selectedThread.goal.objective}` : 'Set a goal'
              }
              hitSlop={(theme.minTouchTarget - theme.iconSize.md) / 2}
            >
              <Target
                size={theme.iconSize.md}
                color={selectedThread?.goal ? theme.colors.accent.default : theme.colors.fg.muted}
              />
            </Pressable>
          ) : null}
          <ConnectionHeader
            connectionStatus={connectionStatus}
            isEncrypted={isEncrypted}
            machinePresence={machinePresence}
            onPress={handleOpenSettings}
          />
        </View>
      </View>

      <ErrorBanner message={error} onDismiss={handleDismissError} />

      {approvals.map((a) => (
        <ApprovalBanner
          key={a.request_id}
          approval={a}
          onAllow={handleAllowApproval}
          onDeny={handleDenyApproval}
        />
      ))}

      <View style={styles.listContainer}>
        {isSyncing ? (
          <View style={styles.syncState}>
            <ActivityIndicator size="small" color={theme.colors.fg.muted} />
            <Text variant="caption" color="muted">
              {connectionStatus === 'encrypted' ? 'Syncing...' : connectionStatus === 'connected' ? 'Securing session...' : 'Connecting...'}
            </Text>
          </View>
        ) : !selectedThread ? (
          <View style={styles.newThreadState}>
            <Text variant="heading" color="primary">
              Let's build
            </Text>
            <Text variant="body" size="lg" color="muted">
              {workspace?.path.split('/').pop() ?? 'Select a project'}
            </Text>
          </View>
        ) : blocks.length === 0 && isSelectedThreadLoading ? (
          <View style={styles.syncState}>
            <ActivityIndicator size="small" color={theme.colors.fg.muted} />
            <Text variant="caption" color="muted">
              Loading thread...
            </Text>
          </View>
        ) : blocks.length === 0 && liveActivityGroups.length === 0 && !isThreadRunning ? (
          <EmptyState title="No messages yet" description="Send a message to get started" />
        ) : (
          <FlashList
            key={selectedThreadId}
            ref={listRef}
            data={blocks}
            renderItem={renderBlock}
            keyExtractor={keyExtractor}
            getItemType={getItemType}
            showsVerticalScrollIndicator={false}
            // Native bottom-pinning: chat opens at the bottom, follows
            // streaming output only while the user is near the bottom, and
            // stays anchored when reading older messages or loading a page
            // above. Replaces a manual scrollToEnd-on-content-size handler
            // that teleported the list whenever recycled cells re-measured.
            maintainVisibleContentPosition={{
              autoscrollToBottomThreshold: 0.2,
              startRenderingFromBottom: true,
            }}
            onScroll={onScroll}
            scrollEventThrottle={16}
            contentContainerStyle={styles.listContent}
            ListHeaderComponent={
              selectedThreadHistory.hasOlder ? (
                <View style={styles.loadOlderContainer}>
                  <Button
                    variant="ghost"
                    size="sm"
                    label={isLoadingOlder ? 'Loading older messages...' : 'Load older messages'}
                    onPress={handleLoadOlder}
                    loading={isLoadingOlder}
                  />
                </View>
              ) : null
            }
            ListFooterComponent={
              <>
                {showThinking ? <ThinkingIndicator /> : null}
                <View style={styles.listBottomSpacer} />
              </>
            }
          />
        )}
        <JumpToBottomFab visible={showJumpButton} onPress={scrollToBottom} />
      </View>

      <LiveActivityLane groups={liveActivityGroups} />

      <GoalBanner goal={selectedThread?.goal ?? null} onPress={() => setIsGoalSheetOpen(true)} />

      <QueuedTurns
        queuedTurns={queuedTurns}
        canSteer={capabilities.supports_steering}
        onRemove={handleRemoveQueuedTurn}
        onSteer={handleSteerQueuedTurn}
        onEdit={handleEditQueuedTurn}
      />

      {/* The keyboard already covers the home indicator, so keeping the inset
          while it is up would float the composer above the keyboard. */}
      <View style={{ paddingBottom: isKeyboardVisible ? 0 : insets.bottom }}>
        <ChatInput
          value={draft}
          onChangeText={setDraft}
          onSubmit={() => void submitTurn()}
          onStop={() => {
            if (isStopping) return
            setIsStopping(true)
            void interruptTurn().finally(() => setIsStopping(false))
          }}
          onPickImages={handlePickImages}
          onRemoveAttachment={removeAttachment}
          disabled={!workspace || isSubmitting || !isEncrypted}
          attachments={attachments}
          skills={workspace?.skills ?? []}
          models={models}
          selectedModel={selectedModel}
          selectedEffort={selectedEffort}
          effortOptions={effortOptions}
          selectedProvider={activeProvider}
          providers={providerOptions}
          showProviderSelector={!selectedThread}
          onSelectModel={handleModelChange}
          onSelectEffort={handleEffortChange}
          onSelectProvider={handleProviderChange}
          isRunning={isThreadRunning}
          isStopping={isStopping}
          capabilities={capabilities}
          selectedPermissionMode={selectedPermissionMode}
          selectedSandboxMode={selectedSandboxMode}
          onSelectPermissionMode={handlePermissionModeChange}
          onSelectSandboxMode={handleSandboxModeChange}
        />
      </View>

      {isGoalSheetOpen && showGoalControl ? (
        <GoalSheet
          goal={selectedThread?.goal ?? null}
          provider={activeProvider}
          onSetGoal={handleSetGoal}
          onClearGoal={handleClearGoal}
          onSetGoalStatus={handleSetGoalStatus}
          onClose={() => setIsGoalSheetOpen(false)}
        />
      ) : null}
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface[0],
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border.subtle,
  },
  headerLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[1],
    marginRight: theme.spacing[3],
  },
  headerTitle: {
    flex: 1,
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[3],
  },
  listContainer: {
    flex: 1,
    minHeight: 2,
  },
  listContent: {
    paddingBottom: theme.spacing[4],
  },
  listBottomSpacer: {
    height: theme.spacing[6],
  },
  syncState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing[3],
  },
  newThreadState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing[2],
  },
  loadOlderContainer: {
    alignItems: 'center',
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
  },
}))

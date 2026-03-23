import { useCallback, useEffect, useMemo, useState } from 'react'
import { ActivityIndicator, AppState, KeyboardAvoidingView, Platform, Pressable, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { FlashList } from '@shopify/flash-list'
import { ChevronLeft } from 'lucide-react-native'
import { DrawerActions } from '@react-navigation/native'
import { useNavigation, useRouter } from 'expo-router'
import {
  defaultProvider,
  encryptJson,
  workspaceModels,
  type AgentProvider,
  type ConversationRenderBlock,
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
import { useRenderBlocks } from '@/hooks/useRenderBlocks'
import { useScrollToBottom } from '@/hooks/useScrollToBottom'
import { useInterruptTurn } from '@/hooks/useInterruptTurn'
import { Button, Text, EmptyState } from '@/components/ui'
import {
  ChatInput,
  ApprovalBanner,
  MessageRouter,
  JumpToBottomFab,
  ThinkingIndicator,
} from '@/components/chat'
import { ConnectionHeader } from '@/components/navigation'
import { getWorkspaceTitle, shouldShowThinkingIndicator } from '@/features/thread/threadScreen'

const renderBlock = ({ item }: { item: ConversationRenderBlock }) => (
  <MessageRouter item={item} />
)
const keyExtractor = (block: ConversationRenderBlock) => block.id
const getItemType = (block: ConversationRenderBlock) =>
  block.kind === 'tool_burst' ? 'tool_burst' : block.item.kind

export default function HomeScreen() {
  const insets = useSafeAreaInsets()
  const { theme } = useUnistyles()
  const navigation = useNavigation()
  const router = useRouter()

  const blocks = useRenderBlocks()
  const approvals = useApprovals()
  const selectedThread = useSelectedThread()
  const selectedThreadHistory = useSelectedThreadHistory()
  const workspace = useSelectedWorkspace()
  const selectedThreadId = useSessionStore((s) => s.selectedThreadId)
  const selectedWorkspaceId = useSessionStore((s) => s.selectedWorkspaceId)
  const selectedThreadItemCount = useSessionStore((s) =>
    s.selectedThreadId ? (s.threadItems[s.selectedThreadId]?.length ?? 0) : 0,
  )
  const snapshot = useSessionStore((s) => s.snapshot)
  const { connectionStatus, isEncrypted, machinePresence, relayUrl, sessionId } = useRelayStore(
    useShallow((s) => ({
      connectionStatus: s.connectionStatus,
      isEncrypted: s.isEncrypted,
      machinePresence: s.machinePresence,
      relayUrl: s.relayUrl,
      sessionId: s.sessionId,
    })),
  )
  const { draft, isSubmitting, selectedEffort, selectedModel, selectedProvider } = useUIStore(
    useShallow((s) => ({
      draft: s.draft,
      isSubmitting: s.isSubmitting,
      selectedEffort: s.selectedEffort,
      selectedModel: s.selectedModel,
      selectedProvider: s.selectedProvider,
    })),
  )
  const { setDraft, setSelectedModel, setSelectedEffort, setSelectedProvider } = useUIStore.getState()
  const { submitTurn, respondApproval, loadThreadDetail } = useSessionActions()
  const interruptTurn = useInterruptTurn()
  const { listRef, showJumpButton, onContentSizeChange, onScroll, pauseAutoScrollOnce, resetScrollState, scrollToBottom } =
    useScrollToBottom<ConversationRenderBlock>()
  const [appState, setAppState] = useState(AppState.currentState)
  const [detailLoadingThreadId, setDetailLoadingThreadId] = useState<string | null>(null)
  const [isLoadingOlder, setIsLoadingOlder] = useState(false)

  // Compute active provider: thread's provider if running, otherwise UI selection or workspace default
  const activeProvider: AgentProvider = selectedThread
    ? selectedThread.provider
    : (selectedProvider ?? defaultProvider(workspace))

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
  const showThinking = shouldShowThinkingIndicator(blocks, isThreadRunning)
  const isSelectedThreadLoading = !!selectedThreadId && detailLoadingThreadId === selectedThreadId

  // True during initial sync: session exists but snapshot hasn't loaded yet
  const isSyncing = !!sessionId && !snapshot

  // Sync provider/model when thread or workspace changes
  useEffect(() => {
    if (!workspace) return
    if (selectedThread) {
      // Thread has a locked provider — sync UI to match
      setSelectedProvider(selectedThread.provider)
    }
  }, [selectedThread, workspace, setSelectedProvider])

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
      // Reset model and effort for the new provider
      setSelectedModel(null)
      setSelectedEffort(null)
    },
    [selectedThread, setSelectedProvider, setSelectedModel, setSelectedEffort],
  )

  const handleOpenDrawer = useCallback(() => {
    navigation.dispatch(DrawerActions.openDrawer())
  }, [navigation])

  const handleOpenSettings = useCallback(() => {
    router.push('/(app)/settings')
  }, [router])

  const handleStop = useCallback(() => {
    void interruptTurn()
  }, [interruptTurn])

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

    pauseAutoScrollOnce()
    setIsLoadingOlder(true)
    void loadThreadDetail(selectedWorkspaceId, selectedThreadId, { older: true }).finally(() => {
      setIsLoadingOlder(false)
    })
  }, [
    isLoadingOlder,
    loadThreadDetail,
    pauseAutoScrollOnce,
    selectedThreadHistory.hasOlder,
    selectedThreadId,
    selectedWorkspaceId,
  ])

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
    if (selectedThreadItemCount === 0) {
      setDetailLoadingThreadId(selectedThreadId)
    }

    void loadThreadDetail(selectedWorkspaceId, selectedThreadId).finally(() => {
      if (cancelled) return
      setDetailLoadingThreadId((current) => (current === selectedThreadId ? null : current))
    })

    return () => {
      cancelled = true
    }
  }, [isEncrypted, loadThreadDetail, selectedThreadId, selectedThreadItemCount, selectedWorkspaceId])

  useEffect(() => {
    if (!selectedThreadId) {
      resetScrollState()
      return
    }

    resetScrollState()
    const frame =
      globalThis.requestAnimationFrame?.(() => {
        scrollToBottom(false)
      }) ?? null
    const timeoutId =
      frame === null
        ? globalThis.setTimeout(() => {
            scrollToBottom(false)
          }, 0)
        : null

    return () => {
      if (typeof frame === 'number' && globalThis.cancelAnimationFrame) {
        globalThis.cancelAnimationFrame(frame)
      }
      if (typeof timeoutId === 'number') {
        globalThis.clearTimeout(timeoutId)
      }
    }
  }, [resetScrollState, scrollToBottom, selectedThreadId])

  useEffect(() => {
    if (appState !== 'active' || !workspace || !selectedThread || !sessionId || !isEncrypted) return

    const readSeq = selectedThread.attention.last_agent_activity_seq
    if (!readSeq || readSeq <= selectedThread.attention.last_read_seq) return

    const relay = useRelayStore.getState()
    const clientToken = relay._getClientToken()
    const sessionCrypto = relay._getSessionCrypto()
    if (!clientToken || !sessionCrypto) return

    void encryptJson(sessionCrypto.dataKey, {
      workspace_id: workspace.id,
      thread_id: selectedThread.id,
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
  }, [appState, isEncrypted, relayUrl, selectedThread, sessionId, workspace])

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={styles.header}>
        <Pressable style={styles.headerLeft} onPress={handleOpenDrawer}>
          <ChevronLeft size={18} color={theme.colors.fg.muted} />
          <Text variant="label" color="primary" weight="semibold" numberOfLines={1} style={styles.headerTitle}>
            {getWorkspaceTitle(workspace?.path)}
          </Text>
        </Pressable>
        <ConnectionHeader
          connectionStatus={connectionStatus}
          isEncrypted={isEncrypted}
          machinePresence={machinePresence}
          onPress={handleOpenSettings}
        />
      </View>

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
        ) : blocks.length === 0 && !isThreadRunning ? (
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
            onContentSizeChange={onContentSizeChange}
            onScroll={onScroll}
            scrollEventThrottle={16}
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
            ListFooterComponent={showThinking ? <ThinkingIndicator /> : null}
          />
        )}
        <JumpToBottomFab visible={showJumpButton} onPress={scrollToBottom} />
      </View>

      <View style={{ paddingBottom: insets.bottom }}>
        <ChatInput
          value={draft}
          onChangeText={setDraft}
          onSubmit={() => void submitTurn()}
          onStop={handleStop}
          disabled={!workspace || isSubmitting || !isEncrypted}
          isRunning={isThreadRunning}
          models={models}
          selectedModel={selectedModel}
          selectedEffort={selectedEffort}
          effortOptions={effortOptions}
          selectedProvider={activeProvider}
          showProviderSelector={!selectedThread}
          onSelectModel={setSelectedModel}
          onSelectEffort={setSelectedEffort}
          onSelectProvider={handleProviderChange}
        />
      </View>
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
  listContainer: {
    flex: 1,
    minHeight: 2,
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

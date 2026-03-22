import { useCallback, useEffect, useState } from 'react'
import { AppState, KeyboardAvoidingView, Platform, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet } from 'react-native-unistyles'
import { FlashList } from '@shopify/flash-list'
import { encryptJson, type ConversationRenderBlock } from '@falcondeck/client-core'
import { useShallow } from 'zustand/react/shallow'

import {
  useApprovals,
  useRelayStore,
  useSessionStore,
  useSelectedThread,
  useSelectedWorkspace,
  useUIStore,
} from '@/store'
import { useRelayConnection } from '@/hooks/useRelayConnection'
import { useSessionActions } from '@/hooks/useSessionActions'
import { useRenderBlocks } from '@/hooks/useRenderBlocks'
import { useScrollToBottom } from '@/hooks/useScrollToBottom'
import { useInterruptTurn } from '@/hooks/useInterruptTurn'
import { Text, EmptyState } from '@/components/ui'
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

  // Start relay connection
  useRelayConnection()

  const blocks = useRenderBlocks()
  const approvals = useApprovals()
  const selectedThread = useSelectedThread()
  const workspace = useSelectedWorkspace()
  const selectedThreadId = useSessionStore((s) => s.selectedThreadId)
  const selectedWorkspaceId = useSessionStore((s) => s.selectedWorkspaceId)
  const { connectionStatus, isEncrypted, machinePresence, relayUrl, sessionId } = useRelayStore(
    useShallow((s) => ({
      connectionStatus: s.connectionStatus,
      isEncrypted: s.isEncrypted,
      machinePresence: s.machinePresence,
      relayUrl: s.relayUrl,
      sessionId: s.sessionId,
    })),
  )
  const { draft, isSubmitting, selectedEffort, selectedModel } = useUIStore(
    useShallow((s) => ({
      draft: s.draft,
      isSubmitting: s.isSubmitting,
      selectedEffort: s.selectedEffort,
      selectedModel: s.selectedModel,
    })),
  )
  const { setDraft, setSelectedModel, setSelectedEffort } = useUIStore.getState()
  const { submitTurn, respondApproval, loadThreadDetail } = useSessionActions()
  const interruptTurn = useInterruptTurn()
  const { listRef, showJumpButton, onContentSizeChange, onScroll, resetScrollState, scrollToBottom } =
    useScrollToBottom<ConversationRenderBlock>()
  const [appState, setAppState] = useState(AppState.currentState)

  const isThreadRunning = selectedThread?.status === 'running'
  const models = workspace?.models ?? []
  const showThinking = shouldShowThinkingIndicator(blocks, isThreadRunning)

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

  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState)
    return () => {
      subscription.remove()
    }
  }, [])

  useEffect(() => {
    if (!selectedWorkspaceId || !selectedThreadId || !isEncrypted) {
      useSessionStore.getState().setThreadDetail(null)
      return
    }

    void loadThreadDetail(selectedWorkspaceId, selectedThreadId)
  }, [isEncrypted, loadThreadDetail, selectedThreadId, selectedWorkspaceId])

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
        <Text variant="label" color="primary" weight="semibold" numberOfLines={1} style={styles.headerTitle}>
          {getWorkspaceTitle(workspace?.path)}
        </Text>
        <ConnectionHeader
          connectionStatus={connectionStatus}
          isEncrypted={isEncrypted}
          machinePresence={machinePresence}
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
        {!selectedThread ? (
          <EmptyState
            title="Start a new thread"
            description="Pick an existing thread or use the plus button from the sidebar."
          />
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
          onSelectModel={setSelectedModel}
          onSelectEffort={setSelectedEffort}
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
  headerTitle: {
    flex: 1,
    marginRight: theme.spacing[3],
  },
  listContainer: {
    flex: 1,
    minHeight: 2,
  },
}))

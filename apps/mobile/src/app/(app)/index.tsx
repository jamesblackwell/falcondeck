import { useCallback, useEffect, useState } from 'react'
import { AppState, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet } from 'react-native-unistyles'
import { FlashList } from '@shopify/flash-list'
import { encryptJson } from '@falcondeck/client-core'

import {
  useConversationItems,
  useApprovals,
  useSelectedThread,
  useSelectedWorkspace,
  useRelayStore,
  useUIStore,
} from '@/store'
import { useRelayConnection } from '@/hooks/useRelayConnection'
import { useSessionActions } from '@/hooks/useSessionActions'
import { Text, EmptyState } from '@/components/ui'
import type { ConversationItem } from '@falcondeck/client-core'
import { MessageBubble, ChatInput, ApprovalBanner } from '@/components/chat'
import { ConnectionHeader } from '@/components/navigation'

const renderMessage = ({ item }: { item: ConversationItem }) => (
  <MessageBubble item={item} />
)
const keyExtractor = (item: ConversationItem) => item.id
const getItemType = (item: ConversationItem) => item.kind

export default function HomeScreen() {
  const insets = useSafeAreaInsets()

  // Start relay connection
  useRelayConnection()

  const items = useConversationItems()
  const approvals = useApprovals()
  const selectedThread = useSelectedThread()
  const workspace = useSelectedWorkspace()
  const connectionStatus = useRelayStore((s) => s.connectionStatus)
  const isEncrypted = useRelayStore((s) => s.isEncrypted)
  const machinePresence = useRelayStore((s) => s.machinePresence)
  const relayUrl = useRelayStore((s) => s.relayUrl)
  const sessionId = useRelayStore((s) => s.sessionId)
  const draft = useUIStore((s) => s.draft)
  const isSubmitting = useUIStore((s) => s.isSubmitting)
  const { setDraft } = useUIStore.getState()
  const { submitTurn, respondApproval } = useSessionActions()
  const [appState, setAppState] = useState(AppState.currentState)

  useEffect(() => {
    const subscription = AppState.addEventListener('change', setAppState)
    return () => {
      subscription.remove()
    }
  }, [])

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
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Text variant="label" color="primary" weight="semibold" numberOfLines={1} style={styles.headerTitle}>
          {workspace?.path.split('/').pop() ?? 'FalconDeck'}
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
          onAllow={(id) => void respondApproval(id, 'allow')}
          onDeny={(id) => void respondApproval(id, 'deny')}
        />
      ))}

      <View style={styles.listContainer}>
        {items.length === 0 ? (
          <EmptyState title="No messages yet" description="Send a message to get started" />
        ) : (
          <FlashList
            data={[...items].reverse()}
            renderItem={renderMessage}
            keyExtractor={keyExtractor}
            getItemType={getItemType}
            showsVerticalScrollIndicator={false}
          />
        )}
      </View>

      <View style={{ paddingBottom: insets.bottom }}>
        <ChatInput
          value={draft}
          onChangeText={setDraft}
          onSubmit={() => void submitTurn()}
          disabled={!workspace || isSubmitting || !isEncrypted}
        />
      </View>
    </View>
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

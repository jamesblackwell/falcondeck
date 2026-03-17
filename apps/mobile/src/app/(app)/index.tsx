import { useCallback } from 'react'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet } from 'react-native-unistyles'
import { FlashList } from '@shopify/flash-list'

import {
  useConversationItems,
  useApprovals,
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
  const workspace = useSelectedWorkspace()
  const connectionStatus = useRelayStore((s) => s.connectionStatus)
  const isEncrypted = useRelayStore((s) => s.isEncrypted)
  const machinePresence = useRelayStore((s) => s.machinePresence)
  const draft = useUIStore((s) => s.draft)
  const isSubmitting = useUIStore((s) => s.isSubmitting)
  const { setDraft } = useUIStore.getState()
  const { submitTurn, respondApproval } = useSessionActions()

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

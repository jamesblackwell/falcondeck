import { memo, useCallback } from 'react'
import { View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { FlashList } from '@shopify/flash-list'
import { Settings, Plus } from 'lucide-react-native'
import { useRouter } from 'expo-router'

import type { ProjectGroup } from '@falcondeck/client-core'

import { Text, Button, StatusIndicator, EmptyState } from '@/components/ui'
import { SessionListItem } from '@/components/chat'

interface SidebarViewProps {
  groups: ProjectGroup[]
  selectedWorkspaceId: string | null
  selectedThreadId: string | null
  connectionStatus: string
  isEncrypted: boolean
  onSelectThread: (workspaceId: string, threadId: string) => void
  onNewThread: (workspaceId: string) => void
}

export const SidebarView = memo(function SidebarView({
  groups,
  selectedWorkspaceId,
  selectedThreadId,
  connectionStatus,
  isEncrypted,
  onSelectThread,
  onNewThread,
}: SidebarViewProps) {
  const { theme } = useUnistyles()
  const insets = useSafeAreaInsets()
  const router = useRouter()

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <View style={styles.headerLeft}>
          <StatusIndicator
            status={isEncrypted ? 'connected' : connectionStatus === 'connecting' ? 'connecting' : 'disconnected'}
            size="md"
            pulse={connectionStatus === 'connecting'}
          />
          <Text variant="heading" size="lg">
            FalconDeck
          </Text>
        </View>
        <Button
          variant="ghost"
          size="icon"
          onPress={() => router.push('/(app)/settings')}
        >
          <Settings size={20} color={theme.colors.fg.muted} />
        </Button>
      </View>

      <View style={styles.list}>
        {groups.length === 0 ? (
          <EmptyState title="No projects" description="Connect from your desktop to get started" />
        ) : (
          groups.map((group) => (
            <View key={group.workspace.id} style={styles.workspaceSection}>
              <View style={styles.workspaceHeader}>
                <Text variant="caption" color="muted" numberOfLines={1} style={styles.workspaceName}>
                  {group.workspace.path.split('/').pop()}
                </Text>
                <Button
                  variant="ghost"
                  size="icon"
                  onPress={() => onNewThread(group.workspace.id)}
                >
                  <Plus size={16} color={theme.colors.fg.muted} />
                </Button>
              </View>
              {group.threads.map((thread) => (
                <SessionListItem
                  key={thread.id}
                  threadId={thread.id}
                  title={thread.title ?? 'New thread'}
                  isRunning={thread.status === 'running'}
                  updatedAt={thread.updated_at}
                  attention={thread.attention}
                  isSelected={selectedThreadId === thread.id}
                  onSelect={() => onSelectThread(group.workspace.id, thread.id)}
                />
              ))}
            </View>
          ))
        )}
      </View>
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface[1],
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[3],
  },
  list: {
    flex: 1,
    paddingVertical: theme.spacing[2],
  },
  workspaceSection: {
    marginBottom: theme.spacing[3],
  },
  workspaceHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[1],
  },
  workspaceName: {
    flex: 1,
  },
}))

import { memo, useCallback } from 'react'
import { View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { AlertTriangle, HelpCircle } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'

import type { ConversationItem } from '@falcondeck/client-core'

import { Text, Button } from '@/components/ui'

type InteractiveRequestItem = Extract<ConversationItem, { kind: 'interactive_request' }>

interface InteractiveRequestBlockProps {
  item: InteractiveRequestItem
  onAllow: (requestId: string) => void
  onDeny: (requestId: string) => void
}

export const InteractiveRequestBlock = memo(function InteractiveRequestBlock({
  item,
  onAllow,
  onDeny,
}: InteractiveRequestBlockProps) {
  const { theme } = useUnistyles()
  const request = item.request

  /* v8 ignore start */
  const handleAllow = useCallback(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
    onAllow(request.request_id)
  }, [request.request_id, onAllow])

  const handleDeny = useCallback(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
    onDeny(request.request_id)
  }, [request.request_id, onDeny])
  /* v8 ignore stop */

  const isApproval = request.kind === 'approval'
  const Icon = isApproval ? AlertTriangle : HelpCircle
  const iconColor = isApproval ? theme.colors.warning.default : theme.colors.info.default
  const bgColor = isApproval ? theme.colors.warning.muted : theme.colors.info.muted

  return (
    <View style={[styles.container, { backgroundColor: bgColor }]}>
      <View style={styles.header}>
        <Icon size={16} color={iconColor} />
        <Text variant="label" color={isApproval ? 'warning' : 'info'} style={styles.title}>
          {request.title}
        </Text>
      </View>
      {request.command ? (
        <Text variant="mono" color="tertiary" size="xs" numberOfLines={3}>
          {request.command}
        </Text>
      ) : null}
      {request.detail ? (
        <Text variant="caption" color="secondary">
          {request.detail}
        </Text>
      ) : null}
      {!item.resolved ? (
        <View style={styles.actions}>
          <Button variant="ghost" size="sm" label="Deny" onPress={handleDeny} />
          <Button variant="default" size="sm" label="Allow" onPress={handleAllow} />
        </View>
      ) : (
        <Text variant="caption" color="muted" style={styles.resolvedLabel}>
          Resolved
        </Text>
      )}
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    borderRadius: theme.radius.lg,
    borderCurve: 'continuous',
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    marginHorizontal: theme.spacing[4],
    marginVertical: theme.spacing[1],
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
  },
  title: {
    flex: 1,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.spacing[2],
  },
  resolvedLabel: {
    fontStyle: 'italic',
  },
}))

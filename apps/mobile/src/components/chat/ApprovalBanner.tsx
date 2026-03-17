import { memo, useCallback } from 'react'
import { View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { AlertTriangle } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'

import type { ApprovalRequest } from '@falcondeck/client-core'

import { Text, Button } from '@/components/ui'

interface ApprovalBannerProps {
  approval: ApprovalRequest
  onAllow: (requestId: string) => void
  onDeny: (requestId: string) => void
}

export const ApprovalBanner = memo(function ApprovalBanner({
  approval,
  onAllow,
  onDeny,
}: ApprovalBannerProps) {
  const { theme } = useUnistyles()

  /* v8 ignore start — Pressable callbacks with haptics, tested via E2E */
  const handleAllow = useCallback(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
    onAllow(approval.request_id)
  }, [approval.request_id, onAllow])

  const handleDeny = useCallback(() => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
    onDeny(approval.request_id)
  }, [approval.request_id, onDeny])
  /* v8 ignore stop */

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <AlertTriangle size={16} color={theme.colors.warning.default} />
        <Text variant="label" color="warning" style={styles.title}>
          {approval.title}
        </Text>
      </View>
      {approval.command ? (
        <Text variant="mono" color="tertiary" size="xs" numberOfLines={3}>
          {approval.command}
        </Text>
      ) : null}
      {approval.detail ? (
        <Text variant="caption" color="secondary">
          {approval.detail}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button variant="ghost" size="sm" label="Deny" onPress={handleDeny} />
        <Button variant="default" size="sm" label="Allow" onPress={handleAllow} />
      </View>
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.warning.muted,
    borderRadius: theme.radius.lg,
    borderCurve: 'continuous',
    padding: theme.spacing[3],
    gap: theme.spacing[2],
    marginHorizontal: theme.spacing[3],
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
}))

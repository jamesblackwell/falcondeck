import { memo, useCallback, useMemo, useState } from 'react'
import { View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { AlertTriangle } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'

import type { ApprovalRequest } from '@falcondeck/client-core'

import { Text, Button } from '@/components/ui'

interface ApprovalBannerProps {
  approval: ApprovalRequest
  pendingCount?: number
  onAllow: (requestId: string) => void | Promise<void>
  onDeny: (requestId: string) => void | Promise<void>
}

function stringField(value: unknown, keys: readonly string[]): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  for (const key of keys) {
    const field = record[key]
    if (typeof field === 'string' && field.trim()) return field.trim()
  }
  return null
}

/** Provider payloads sometimes put the full tool input JSON in `detail`, even
 * when command/path have already been promoted into their own fields. Keep
 * useful human copy and never expose that transport object in the prompt. */
export function approvalDetail(approval: ApprovalRequest): string | null {
  const detail = approval.detail?.trim()
  if (!detail) return null
  if (!detail.startsWith('{') && !detail.startsWith('[')) return detail

  try {
    const payload = JSON.parse(detail) as unknown
    const summary = stringField(payload, ['description', 'reason', 'message', 'prompt'])
    if (summary && summary !== approval.command && summary !== approval.path) return summary
    return null
  } catch {
    return detail
  }
}

export const ApprovalBanner = memo(function ApprovalBanner({
  approval,
  pendingCount = 1,
  onAllow,
  onDeny,
}: ApprovalBannerProps) {
  const { theme } = useUnistyles()
  const [isResponding, setIsResponding] = useState(false)
  const detail = useMemo(() => approvalDetail(approval), [approval])

  /* v8 ignore start — Pressable callbacks with haptics, tested via E2E */
  const handleAllow = useCallback(async () => {
    if (isResponding) return
    setIsResponding(true)
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
    try {
      await onAllow(approval.request_id)
    } finally {
      setIsResponding(false)
    }
  }, [approval.request_id, isResponding, onAllow])

  const handleDeny = useCallback(async () => {
    if (isResponding) return
    setIsResponding(true)
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)
    try {
      await onDeny(approval.request_id)
    } finally {
      setIsResponding(false)
    }
  }, [approval.request_id, isResponding, onDeny])
  /* v8 ignore stop */

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <View style={styles.icon}>
          <AlertTriangle size={16} color={theme.colors.warning.default} />
        </View>
        <View style={styles.heading}>
          <Text variant="caption" color="warning" weight="semibold">
            Permission required
          </Text>
          <Text variant="label" color="primary" style={styles.title}>
            {approval.title}
          </Text>
        </View>
        {pendingCount > 1 ? (
          <Text variant="caption" color="muted">
            1 of {pendingCount}
          </Text>
        ) : null}
      </View>
      {approval.command ? (
        <View style={styles.command}>
          <Text variant="mono" color="secondary" size="xs" numberOfLines={4}>
            {approval.command}
          </Text>
        </View>
      ) : null}
      {detail ? (
        <Text variant="caption" color="secondary">
          {detail}
        </Text>
      ) : null}
      {approval.path && !approval.command?.includes(approval.path) ? (
        <Text variant="caption" color="muted" numberOfLines={1}>
          {approval.path}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button variant="ghost" size="sm" label="Deny" disabled={isResponding} onPress={handleDeny} />
        <Button variant="default" size="sm" label="Allow" loading={isResponding} onPress={handleAllow} />
      </View>
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.warning.muted,
    borderRadius: theme.radius.lg,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: theme.colors.warning.default,
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
  icon: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surface[1],
  },
  heading: {
    flex: 1,
    gap: 1,
  },
  title: {
    flex: 1,
  },
  command: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.radius.md,
    backgroundColor: theme.colors.surface[1],
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.spacing[2],
  },
}))

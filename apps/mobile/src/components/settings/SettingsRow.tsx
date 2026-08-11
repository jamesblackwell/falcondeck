import { memo, type ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { ChevronRight } from 'lucide-react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import { Text } from '@/components/ui'

type SettingsRowProps = {
  label: string
  detail?: string
  value?: string
  icon?: ReactNode
  onPress?: () => void
  destructive?: boolean
  accessibilityHint?: string
}

export const SettingsRow = memo(function SettingsRow({
  label,
  detail,
  value,
  icon,
  onPress,
  destructive = false,
  accessibilityHint,
}: SettingsRowProps) {
  const { theme } = useUnistyles()
  const content = (
    <>
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      <View style={styles.copy}>
        <Text variant="label" color={destructive ? 'danger' : 'primary'}>
          {label}
        </Text>
        {detail ? (
          <Text variant="caption" color="muted" style={styles.detail}>
            {detail}
          </Text>
        ) : null}
      </View>
      {value ? (
        <Text variant="body" color="tertiary" numberOfLines={1} style={styles.value}>
          {value}
        </Text>
      ) : null}
      {onPress ? <ChevronRight size={theme.iconSize.xs} color={theme.colors.fg.faint} /> : null}
    </>
  )

  if (!onPress) return <View style={styles.row}>{content}</View>

  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : undefined]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}, ${value}` : label}
      accessibilityHint={accessibilityHint}
    >
      {content}
    </Pressable>
  )
})

const styles = StyleSheet.create((theme) => ({
  row: {
    minHeight: theme.minTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border.subtle,
  },
  pressed: { backgroundColor: theme.colors.surface[2] },
  icon: {
    width: 28,
    alignItems: 'center',
  },
  copy: { flex: 1 },
  detail: { marginTop: theme.spacing[1] },
  value: { maxWidth: '42%', textAlign: 'right' },
}))

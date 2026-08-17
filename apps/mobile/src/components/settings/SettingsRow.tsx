import { memo, type ReactNode } from 'react'
import { Pressable, View } from 'react-native'
import { Check, ChevronRight, Copy } from 'lucide-react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'

import { Text } from '@/components/ui'
import { useClipboardCopy } from '@/hooks/useClipboardCopy'

type SettingsRowProps = {
  label: string
  detail?: string
  value?: string
  icon?: ReactNode
  onPress?: () => void
  destructive?: boolean
  accessibilityHint?: string
  /** Tapping copies `value` instead of navigating — for ids you may need to
   *  quote when something goes wrong and cannot otherwise select. */
  copyable?: boolean
}

export const SettingsRow = memo(function SettingsRow({
  label,
  detail,
  value,
  icon,
  onPress,
  destructive = false,
  accessibilityHint,
  copyable = false,
}: SettingsRowProps) {
  const { theme } = useUnistyles()
  const { copy, result } = useClipboardCopy(
    value ?? '',
    `${label} copied`,
    `Could not copy ${label}`,
  )
  const isCopyRow = copyable && Boolean(value)
  const navigates = Boolean(onPress) && !isCopyRow

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
        <Text
          variant="body"
          color={result === 'copied' ? 'accent' : 'tertiary'}
          numberOfLines={2}
          ellipsizeMode={navigates ? 'tail' : 'middle'}
          style={[styles.value, navigates ? styles.valueCompact : undefined]}
        >
          {/* The value stays put on copy — swapping in "Copied" reflowed the
              row from two lines to one and shoved the rest of the list. The
              check, the accent colour, and the VoiceOver announcement carry
              the confirmation instead. */}
          {value}
        </Text>
      ) : null}
      {isCopyRow ? (
        result === 'copied' ? (
          <Check size={theme.iconSize.sm} color={theme.colors.accent.default} />
        ) : (
          <Copy size={theme.iconSize.sm} color={theme.colors.fg.faint} />
        )
      ) : null}
      {navigates ? (
        <ChevronRight size={theme.iconSize.xs} color={theme.colors.fg.faint} />
      ) : null}
    </>
  )

  if (!onPress && !isCopyRow) return <View style={styles.row}>{content}</View>

  return (
    <Pressable
      style={({ pressed }) => [styles.row, pressed ? styles.pressed : undefined]}
      onPress={isCopyRow ? () => void copy() : onPress}
      accessibilityRole="button"
      accessibilityLabel={value ? `${label}, ${value}` : label}
      accessibilityHint={
        isCopyRow ? accessibilityHint ?? 'Copies to the clipboard' : accessibilityHint
      }
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
  },
  pressed: { backgroundColor: theme.colors.surface[2] },
  icon: {
    width: 28,
    alignItems: 'center',
  },
  copy: { flex: 1 },
  detail: { marginTop: theme.spacing[1] },
  // Read-only rows are label + value, so the value gets the room it needs;
  // rows that navigate keep the label dominant and let the value shrink.
  value: { flexShrink: 1, maxWidth: '60%', textAlign: 'right' },
  valueCompact: { maxWidth: '45%' },
}))

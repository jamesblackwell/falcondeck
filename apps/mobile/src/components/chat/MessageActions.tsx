import { memo } from 'react'
import { Check, CircleX, Copy } from 'lucide-react-native'
import { useUnistyles } from 'react-native-unistyles'

import { Button } from '@/components/ui'
import { useClipboardCopy } from './useClipboardCopy'

function copyTarget(accessibilityLabel: string) {
  const target = accessibilityLabel.replace(/^copy\s+/i, '').trim()
  return target || 'content'
}

export const MessageActions = memo(function MessageActions({
  text,
  accessibilityLabel = 'Copy response',
}: {
  text: string
  accessibilityLabel?: string
}) {
  const { theme } = useUnistyles()
  const target = copyTarget(accessibilityLabel)
  const successLabel = `${target[0]?.toUpperCase() ?? ''}${target.slice(1)} copied`
  const failureLabel = `Could not copy ${target}`
  const { copy, result } = useClipboardCopy(text, successLabel, failureLabel)

  if (!text.trim()) return null

  const currentAccessibilityLabel = result === 'copied'
    ? successLabel
    : result === 'failed'
      ? `${failureLabel}. Retry`
      : accessibilityLabel
  const icon = result === 'copied' ? (
    <Check size={theme.iconSize.xs} color={theme.colors.success.default} />
  ) : result === 'failed' ? (
    <CircleX size={theme.iconSize.xs} color={theme.colors.danger.default} />
  ) : (
    <Copy size={theme.iconSize.xs} color={theme.colors.fg.muted} />
  )

  return (
    <Button
      variant="ghost"
      size="icon"
      accessibilityLabel={currentAccessibilityLabel}
      accessibilityLiveRegion="polite"
      icon={icon}
      onPress={() => { void copy() }}
    />
  )
})

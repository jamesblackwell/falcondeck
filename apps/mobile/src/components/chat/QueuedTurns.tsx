import { memo, useCallback, useState } from 'react'
import { ActivityIndicator, Pressable, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Clock, Paperclip } from 'lucide-react-native'

import type { QueuedTurnSummary } from '@falcondeck/client-core'

import { OptionSheet, Text, type OptionSheetItem } from '@/components/ui'

/** Matches the desktop copy for the same disabled action. */
export const STEER_UNAVAILABLE_REASON = 'This agent cannot take a message mid-turn.'

export function queuedTurnLabel(queued: QueuedTurnSummary): string {
  return queued.preview.trim() || 'Queued message'
}

export function queuedTurnActions(canSteer: boolean): OptionSheetItem[] {
  return [
    {
      value: 'steer',
      label: 'Steer instead',
      description: 'Send it into the running turn instead of waiting.',
      disabled: !canSteer,
      disabledReason: STEER_UNAVAILABLE_REASON,
    },
    { value: 'remove', label: 'Remove', destructive: true },
  ]
}

interface QueuedTurnsProps {
  queuedTurns: QueuedTurnSummary[]
  /** From the agent's capability summary; steering is disabled, not hidden. */
  canSteer: boolean
  onRemove: (queuedId: string) => Promise<void>
  onSteer: (queuedId: string) => Promise<void>
}

/** Messages accepted while the thread was busy, waiting their turn. Each is
    removable, and steerable into the running turn where the agent allows it. */
export const QueuedTurns = memo(function QueuedTurns({
  queuedTurns,
  canSteer,
  onRemove,
  onSteer,
}: QueuedTurnsProps) {
  const { theme } = useUnistyles()
  const [openId, setOpenId] = useState<string | null>(null)
  const [pendingId, setPendingId] = useState<string | null>(null)

  const open = queuedTurns.find((queued) => queued.id === openId) ?? null

  const runAction = useCallback(
    (queuedId: string, value: string) => {
      setOpenId(null)
      setPendingId(queuedId)
      const action = value === 'steer' ? onSteer(queuedId) : onRemove(queuedId)
      // A failed steer leaves the message queued daemon-side, so the chip
      // stays put either way; the error surfaces through the relay banner.
      void action.catch(() => {}).finally(() => {
        setPendingId((current) => (current === queuedId ? null : current))
      })
    },
    [onRemove, onSteer],
  )

  if (queuedTurns.length === 0) return null

  return (
    <View style={styles.container}>
      {queuedTurns.map((queued) => {
        const label = queuedTurnLabel(queued)
        const isPending = pendingId === queued.id
        const attachmentCount = queued.attachment_count ?? 0

        return (
          <Pressable
            key={queued.id}
            style={[styles.chip, isPending ? styles.chipPending : null]}
            disabled={isPending}
            accessibilityRole="button"
            accessibilityLabel={`Queued message: ${label}`}
            accessibilityHint="Opens actions for this queued message"
            accessibilityState={{ disabled: isPending }}
            onPress={() => setOpenId(queued.id)}
          >
            {isPending ? (
              <ActivityIndicator size="small" color={theme.colors.fg.muted} />
            ) : (
              <Clock size={theme.iconSize.xs} color={theme.colors.fg.muted} />
            )}
            <Text variant="caption" size="xs" color="secondary" numberOfLines={1} style={styles.label}>
              {label}
            </Text>
            {attachmentCount > 0 ? (
              <View style={styles.attachments}>
                <Paperclip size={theme.iconSize.xs} color={theme.colors.fg.muted} />
                <Text variant="caption" size="2xs" color="muted">
                  {attachmentCount}
                </Text>
              </View>
            ) : null}
            <Text variant="caption" size="2xs" color="muted">
              queued
            </Text>
          </Pressable>
        )
      })}

      {open ? (
        <OptionSheet
          title={queuedTurnLabel(open)}
          items={queuedTurnActions(canSteer)}
          onSelect={(value) => runAction(open.id, value)}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
    gap: theme.spacing[1.5],
  },
  chip: {
    // Right-aligned and dashed, like the desktop chips: these read as the
    // user's own not-yet-sent messages, not as agent output.
    alignSelf: 'flex-end',
    maxWidth: '90%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    minHeight: theme.minTouchTarget,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.radius.lg,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: theme.colors.border.emphasis,
    backgroundColor: theme.colors.surface[2],
  },
  chipPending: {
    opacity: 0.6,
  },
  label: {
    flexShrink: 1,
  },
  attachments: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[0.5],
  },
}))

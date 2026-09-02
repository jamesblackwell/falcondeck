import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Image } from 'expo-image'
import { CornerDownRight, Paperclip, Trash2 } from 'lucide-react-native'

import type { QueuedTurnSummary } from '@falcondeck/client-core'

import {
  ActivityDiamond,
  Button,
  Input,
  NativeSheet,
  OptionSheet,
  Text,
  type OptionSheetItem,
} from '@/components/ui'

/** Matches the desktop copy for the same disabled action. */
export const STEER_UNAVAILABLE_REASON = 'This agent cannot take a message mid-turn.'

export function queuedTurnLabel(queued: QueuedTurnSummary): string {
  return queued.preview.trim() || 'Queued message'
}

export function queuedTurnActions(canSteer: boolean): OptionSheetItem[] {
  return [
    {
      value: 'edit',
      label: 'Edit message',
      description: 'Change the text before it sends.',
    },
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

/** Loads the first image attachment's preview for one chip, once. The daemon
    returns a `data:` URL over the relay — remote clients cannot reach its
    loopback preview route — and a miss simply leaves the row image-free. */
function useAttachmentPreview(
  queuedId: string,
  hasAttachment: boolean,
  load: QueuedTurnsProps['getAttachmentPreview'],
) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    if (!hasAttachment || !load) {
      setUrl(null)
      return
    }
    let active = true
    void load(queuedId)
      .then((next) => {
        if (active) setUrl(next)
      })
      .catch(() => {
        if (active) setUrl(null)
      })
    return () => {
      active = false
    }
  }, [hasAttachment, load, queuedId])

  return url
}

interface QueuedTurnRowProps {
  queued: QueuedTurnSummary
  canSteer: boolean
  isPending: boolean
  isFirst: boolean
  getAttachmentPreview: QueuedTurnsProps['getAttachmentPreview']
  onOpenActions: () => void
  onSteer: () => void
  onRemove: () => void
}

const QueuedTurnRow = memo(function QueuedTurnRow({
  queued,
  canSteer,
  isPending,
  isFirst,
  getAttachmentPreview,
  onOpenActions,
  onSteer,
  onRemove,
}: QueuedTurnRowProps) {
  const { theme } = useUnistyles()
  const label = queuedTurnLabel(queued)
  const attachmentCount = queued.attachment_count ?? 0
  const previewUrl = useAttachmentPreview(queued.id, attachmentCount > 0, getAttachmentPreview)

  return (
    <View style={[styles.row, isFirst ? null : styles.rowDivided, isPending ? styles.rowPending : null]}>
      <Pressable
        style={styles.rowMain}
        disabled={isPending}
        accessibilityRole="button"
        accessibilityLabel={`Queued message: ${label}`}
        accessibilityHint="Opens actions for this queued message"
        accessibilityState={{ disabled: isPending }}
        onPress={onOpenActions}
      >
        {isPending ? (
          <ActivityDiamond size={theme.iconSize.sm} color={theme.colors.fg.muted} />
        ) : (
          <CornerDownRight size={theme.iconSize.sm} color={theme.colors.fg.muted} />
        )}

        {previewUrl ? (
          <Image
            source={{ uri: previewUrl }}
            style={styles.thumbnail}
            contentFit="cover"
            accessibilityIgnoresInvertColors
          />
        ) : null}

        <Text variant="label" color="primary" numberOfLines={1} style={styles.label}>
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
      </Pressable>

      {/* Steering is the action worth a tap of its own: it is the difference
          between the message landing now and landing after the turn. Disabled
          rather than hidden where the agent cannot take it, like desktop.
          Kept outside the row pressable so a Steer tap cannot also open the
          sheet (and fire Steer a second time). */}
      <Pressable
        style={({ pressed }) => [
          styles.steerButton,
          pressed && canSteer ? styles.steerButtonPressed : null,
          canSteer ? null : styles.steerButtonDisabled,
        ]}
        disabled={!canSteer || isPending}
        accessibilityRole="button"
        accessibilityLabel={`Steer queued message: ${label}`}
        accessibilityHint={canSteer ? 'Sends it into the running turn' : STEER_UNAVAILABLE_REASON}
        accessibilityState={{ disabled: !canSteer || isPending }}
        onPress={onSteer}
      >
        <CornerDownRight
          size={theme.iconSize.xs}
          color={canSteer ? theme.colors.fg.secondary : theme.colors.fg.muted}
        />
        <Text variant="caption" size="xs" color={canSteer ? 'secondary' : 'muted'} weight="medium">
          Steer
        </Text>
      </Pressable>

      <Pressable
        style={({ pressed }) => [styles.removeButton, pressed ? styles.removeButtonPressed : null]}
        disabled={isPending}
        accessibilityRole="button"
        accessibilityLabel={`Remove queued message: ${label}`}
        accessibilityState={{ disabled: isPending }}
        onPress={onRemove}
      >
        <Trash2 size={theme.iconSize.sm} color={theme.colors.fg.muted} />
      </Pressable>
    </View>
  )
})

interface QueuedTurnsProps {
  queuedTurns: QueuedTurnSummary[]
  /** From the agent's capability summary; steering is disabled, not hidden. */
  canSteer: boolean
  onRemove: (queuedId: string) => Promise<void>
  onSteer: (queuedId: string) => Promise<void>
  onEdit: (queuedId: string, text: string) => Promise<void>
  /** Resolves the queued message's image thumbnail, or null when there is
      none to show. Omitted in previews and tests. */
  getAttachmentPreview?: (queuedId: string) => Promise<string | null>
}

/** Messages accepted while the thread was busy, waiting their turn. Rendered
    as one card directly above the composer — the same shape desktop uses — so
    the queue reads as pending input rather than transcript. Each row shows its
    attachment, steers into the running turn, or drops out of the queue. */
export const QueuedTurns = memo(function QueuedTurns({
  queuedTurns,
  canSteer,
  onRemove,
  onSteer,
  onEdit,
  getAttachmentPreview,
}: QueuedTurnsProps) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [editing, setEditing] = useState<QueuedTurnSummary | null>(null)
  const [editText, setEditText] = useState('')
  const [pendingIds, setPendingIds] = useState<Set<string>>(() => new Set())
  const pendingIdsRef = useRef(new Set<string>())

  const open = queuedTurns.find((queued) => queued.id === openId) ?? null

  useEffect(() => {
    if (openId && !open) setOpenId(null)
    if (editing && !queuedTurns.some((queued) => queued.id === editing.id)) {
      setEditing(null)
      setEditText('')
    }
  }, [editing, open, openId, queuedTurns])

  const trackAction = useCallback((queuedId: string, action: () => Promise<void>) => {
    if (pendingIdsRef.current.has(queuedId)) return
    pendingIdsRef.current.add(queuedId)
    setPendingIds(new Set(pendingIdsRef.current))
    // A failed action leaves the message queued daemon-side, so the row
    // stays put either way; the error surfaces through the relay banner.
    void Promise.resolve()
      .then(action)
      .catch(() => {})
      .finally(() => {
        pendingIdsRef.current.delete(queuedId)
        setPendingIds(new Set(pendingIdsRef.current))
      })
  }, [])

  const runAction = useCallback(
    (queued: QueuedTurnSummary, value: string) => {
      setOpenId(null)
      if (value === 'edit') {
        // Use the full text, not the truncated preview — saving a
        // preview-truncated draft would chop long messages.
        setEditing(queued)
        setEditText(queued.text ?? queued.preview)
        return
      }
      trackAction(
        queued.id,
        value === 'steer'
          ? () => onSteer(queued.id)
          : () => onRemove(queued.id),
      )
    },
    [onRemove, onSteer, trackAction],
  )

  if (queuedTurns.length === 0) return null

  return (
    <View style={styles.container}>
      <View style={styles.card} accessibilityLabel="Queued messages">
        {queuedTurns.map((queued, index) => (
          <QueuedTurnRow
            key={queued.id}
            queued={queued}
            canSteer={canSteer}
            isPending={pendingIds.has(queued.id)}
            isFirst={index === 0}
            getAttachmentPreview={getAttachmentPreview}
            onOpenActions={() => setOpenId(queued.id)}
            onSteer={() => trackAction(queued.id, () => onSteer(queued.id))}
            onRemove={() => trackAction(queued.id, () => onRemove(queued.id))}
          />
        ))}
      </View>

      {open ? (
        <OptionSheet
          key={open.id}
          title={queuedTurnLabel(open)}
          items={queuedTurnActions(canSteer)}
          onSelect={(value) => runAction(open, value)}
          onClose={() => setOpenId(null)}
        />
      ) : null}

      {editing ? (
        <NativeSheet
          accessibilityLabel="Close queued message editor"
          onClose={() => {
            setEditing(null)
            setEditText('')
          }}
          contentStyle={styles.editor}
        >
          <Text variant="heading" color="primary">Edit message</Text>
          <Input
            accessibilityLabel="Queued message text"
            value={editText}
            onChangeText={setEditText}
            multiline
            autoFocus
            style={styles.editorInput}
          />
          <View style={styles.editorActions}>
            <Button
              variant="ghost"
              label="Cancel"
              accessibilityLabel="Cancel queued message edit"
              onPress={() => {
                setEditing(null)
                setEditText('')
              }}
            />
            <Button
              label="Save"
              accessibilityLabel="Save queued message edit"
              disabled={!editText.trim()}
              onPress={() => {
                const queuedId = editing.id
                const next = editText.trim()
                if (!next) return
                setEditing(null)
                setEditText('')
                trackAction(queuedId, () => onEdit(queuedId, next))
              }}
            />
          </View>
        </NativeSheet>
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    // Mirror the composer's own padding so this card's edges line up with the
    // prompt card below it, exactly as on desktop.
    paddingHorizontal: theme.spacing[3],
    paddingBottom: theme.spacing[2],
  },
  card: {
    borderRadius: theme.radius.xl,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    backgroundColor: theme.colors.surface[2],
    overflow: 'hidden',
  },
  editor: {
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[4],
  },
  editorInput: {
    minHeight: 120,
    textAlignVertical: 'top',
  },
  editorActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: theme.spacing[2],
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    minHeight: theme.minTouchTarget,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
  },
  rowMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    minHeight: theme.minTouchTarget,
  },
  rowDivided: {
    borderTopWidth: 1,
    borderTopColor: theme.colors.border.subtle,
  },
  rowPending: {
    opacity: 0.6,
  },
  thumbnail: {
    width: 32,
    height: 32,
    borderRadius: theme.radius.sm,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: theme.colors.border.subtle,
    backgroundColor: theme.colors.surface[3],
  },
  label: {
    flex: 1,
  },
  attachments: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[0.5],
  },
  steerButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    borderRadius: theme.radius.md,
    borderCurve: 'continuous',
    backgroundColor: theme.colors.surface[3],
  },
  steerButtonPressed: {
    backgroundColor: theme.colors.surface[4],
  },
  steerButtonDisabled: {
    opacity: 0.5,
  },
  removeButton: {
    padding: theme.spacing[1.5],
    borderRadius: theme.radius.md,
    borderCurve: 'continuous',
  },
  removeButtonPressed: {
    backgroundColor: theme.colors.danger.muted,
  },
}))

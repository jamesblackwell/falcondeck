import { memo } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import Animated from 'react-native-reanimated'
import {
  ChevronRight,
  CheckCircle2,
  CircleX,
  FileDiff,
  PauseCircle,
} from 'lucide-react-native'

import {
  fileChangeLifecycle,
  toolLifecycleLabel,
  type ConversationItem,
} from '@falcondeck/client-core'

import { ActivityDiamond, Text } from '@/components/ui'
import { CodeBlock } from './CodeBlock'
import { useCollapsible } from './useCollapsible'

type FileChangeItem = Extract<ConversationItem, { kind: 'file_change' }>

interface FileChangeBlockProps {
  item: FileChangeItem
  defaultOpen: boolean
}

function basename(path: string) {
  const normalized = path.replaceAll('\\', '/')
  return normalized.slice(normalized.lastIndexOf('/') + 1) || path
}

function changeKindLabel(change: FileChangeItem['changes'][number]) {
  if (change.move_path) return 'Renamed'
  switch (change.change_kind.toLowerCase()) {
    case 'add':
      return 'Added'
    case 'delete':
      return 'Deleted'
    case 'update':
      return 'Updated'
    default:
      return change.change_kind || 'Changed'
  }
}

export const FileChangeBlock = memo(function FileChangeBlock({
  item,
  defaultOpen,
}: FileChangeBlockProps) {
  const { theme } = useUnistyles()
  const lifecycle = fileChangeLifecycle(item)
  const lifecycleLabel = toolLifecycleLabel(lifecycle)
  const { bodyStyle, chevronStyle, isOpen, onContentLayout, toggle } = useCollapsible(
    defaultOpen,
    item.id,
  )
  const count = item.changes.length
  const onlyChange = count === 1 ? item.changes[0] : null
  const label = onlyChange
    ? `${changeKindLabel(onlyChange)} ${basename(onlyChange.path)}`
    : count > 0
      ? `${count} files changed`
      : lifecycle === 'running' || lifecycle === 'queued'
        ? 'Preparing file changes…'
        : 'File change'
  const statusIcon =
    lifecycle === 'running' || lifecycle === 'queued' ? (
      <ActivityDiamond size={14} color={theme.colors.accent.default} />
    ) : lifecycle === 'failed' || lifecycle === 'denied' ? (
      <CircleX accessible={false} size={14} color={theme.colors.danger.default} />
    ) : lifecycle === 'interrupted' ? (
      <PauseCircle accessible={false} size={14} color={theme.colors.warning.default} />
    ) : (
      <CheckCircle2 accessible={false} size={14} color={theme.colors.success.default} />
    )

  return (
    <View style={styles.container}>
      <Pressable
        style={styles.header}
        onPress={count > 0 ? toggle : undefined}
        disabled={count === 0}
        accessibilityRole={count > 0 ? 'button' : undefined}
        accessibilityLabel={`${label}, ${lifecycleLabel}`}
        accessibilityHint={
          count > 0 ? (isOpen ? 'Collapses file changes' : 'Expands file changes') : undefined
        }
        accessibilityState={count > 0 ? { expanded: isOpen } : undefined}
      >
        {statusIcon}
        <Text color="secondary" size="sm" style={styles.title} numberOfLines={1}>
          {label}
        </Text>
        <Text variant="caption" color="muted" size="2xs">
          {lifecycleLabel}
        </Text>
        {count > 0 ? (
          <Animated.View style={chevronStyle}>
            <ChevronRight accessible={false} size={14} color={theme.colors.fg.muted} />
          </Animated.View>
        ) : null}
      </Pressable>
      {count > 0 ? (
        <Animated.View style={bodyStyle}>
          <View onLayout={onContentLayout} style={styles.body}>
            {item.changes.map((change, index) => (
              <View key={`${change.path}-${index}`} style={styles.change}>
                <View style={styles.pathRow}>
                  <FileDiff accessible={false} size={14} color={theme.colors.fg.muted} />
                  <Text selectable variant="mono" color="secondary" size="xs" style={styles.path} numberOfLines={1}>
                    {change.path}
                    {change.move_path ? ` → ${change.move_path}` : ''}
                  </Text>
                  <Text variant="caption" color="faint" size="2xs">
                    {changeKindLabel(change).toUpperCase()}
                  </Text>
                </View>
                {change.diff.trim() ? (
                  <CodeBlock code={change.diff} language="diff" previewLines={isOpen ? 0 : 8} />
                ) : null}
              </View>
            ))}
          </View>
        </Animated.View>
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    backgroundColor: theme.colors.surface[2],
    borderRadius: theme.radius.lg,
    borderCurve: 'continuous',
    borderWidth: 1,
    borderColor: theme.colors.border.subtle,
    marginHorizontal: theme.spacing[4],
    marginVertical: theme.spacing[1],
    overflow: 'hidden',
  },
  header: {
    minHeight: theme.minTouchTarget,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  title: {
    flex: 1,
  },
  body: {
    gap: theme.spacing[3],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border.subtle,
    padding: theme.spacing[2],
  },
  change: {
    gap: theme.spacing[2],
  },
  pathRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
  },
  path: {
    flex: 1,
  },
}))

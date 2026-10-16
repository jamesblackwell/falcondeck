import { memo, type ReactNode } from 'react'
import { Pressable, View, type LayoutChangeEvent } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { ChevronDown, MoreHorizontal, PanelLeft, SquarePen } from 'lucide-react-native'

import { isDaemonRpcReady, type MachinePresence } from '@falcondeck/client-core'

import {
  GLASS_CONTROL_SIZE,
  GlassButton,
  GlassButtonGroup,
  GlassGroupItem,
  GlassSurface,
  SymbolIcon,
  Text,
} from '@/components/ui'
import { CHROME_MAX_FONT_SCALE } from '@/lib/glass'

import { connectionState } from './ConnectionHeader'
import { FloatingHeader } from './FloatingHeader'

interface ThreadHeaderProps {
  title: string
  subtitle?: string | null
  /** Accessible summary of where the reader is, read before the title. */
  accessibilityLabel: string
  /** Opens the task list; omitted where the sidebar never leaves the screen. */
  onOpenSidebar?: () => void
  /** Opens the task's options from the title, as the overflow button does. */
  onPressTitle?: () => void
  onNewThread?: () => void
  onOpenOptions?: () => void
  connectionStatus: string
  isEncrypted: boolean
  machinePresence: MachinePresence | null
  onPressConnection?: () => void
  /** Notices that float with the header, under the controls. */
  children?: ReactNode
  onLayout?: (event: LayoutChangeEvent) => void
}

/**
 * The conversation's navigation bar: a glass sidebar button, the task title
 * on its own glass capsule, and the task actions grouped on a second, the
 * way iOS 26 clusters bar items. The connection dot stays in the cluster so
 * the link to the desktop is always one glance (and one tap) away.
 */
export const ThreadHeader = memo(function ThreadHeader({
  title,
  subtitle,
  accessibilityLabel,
  onOpenSidebar,
  onPressTitle,
  onNewThread,
  onOpenOptions,
  connectionStatus,
  isEncrypted,
  machinePresence,
  onPressConnection,
  children,
  onLayout,
}: ThreadHeaderProps) {
  const { theme } = useUnistyles()
  const iconColor = theme.colors.fg.primary
  const connection = connectionState(
    connectionStatus,
    isEncrypted,
    machinePresence?.daemon_connected ?? false,
    isDaemonRpcReady(machinePresence),
    machinePresence !== null,
  )
  const dotColor =
    connection.tone === 'connected'
      ? theme.colors.success.default
      : connection.tone === 'repairing'
        ? theme.colors.warning.default
        : theme.colors.danger.default

  const titleBody = (
    <View style={styles.titleText}>
      <Text variant="label" size="sm" weight="semibold" color="primary" numberOfLines={1} maxFontSizeMultiplier={CHROME_MAX_FONT_SCALE}>
        {title}
      </Text>
      {subtitle ? (
        <Text variant="caption" size="xs" color="muted" numberOfLines={1} maxFontSizeMultiplier={CHROME_MAX_FONT_SCALE} style={styles.subtitle}>
          {subtitle}
        </Text>
      ) : null}
    </View>
  )

  return (
    <FloatingHeader
      onLayout={onLayout}
      left={
        onOpenSidebar ? (
          <GlassButton
            onPress={onOpenSidebar}
            accessibilityLabel="Open task list"
            accessibilityHint="Shows your projects and tasks"
            testID="thread-header-sidebar"
          >
            <SymbolIcon name="sidebar.left" fallback={PanelLeft} size={20} color={iconColor} />
          </GlassButton>
        ) : null
      }
      center={
        <Pressable
          onPress={onPressTitle}
          disabled={!onPressTitle}
          accessibilityRole={onPressTitle ? 'button' : 'header'}
          accessibilityLabel={accessibilityLabel}
          accessibilityHint={onPressTitle ? 'Opens task options' : undefined}
          style={styles.titlePressable}
          testID="thread-header-title"
        >
          <GlassSurface
            radius={GLASS_CONTROL_SIZE / 2}
            interactive={Boolean(onPressTitle)}
            intensity={70}
            highlight={false}
            fill
            style={styles.titleCapsule}
            contentStyle={styles.titleContent}
          >
            {titleBody}
            {onPressTitle ? (
              <SymbolIcon
                name="chevron.down"
                fallback={ChevronDown}
                size={11}
                weight="semibold"
                color={theme.colors.fg.muted}
              />
            ) : null}
          </GlassSurface>
        </Pressable>
      }
      right={
        <GlassButtonGroup>
          <GlassGroupItem
            width={32}
            onPress={onPressConnection}
            accessibilityLabel={`Connection: ${connection.label}`}
            accessibilityHint="Shows what the connection is doing"
            testID="thread-header-connection"
          >
            <View style={[styles.dot, { backgroundColor: dotColor }]} />
          </GlassGroupItem>
          {onNewThread ? (
            <GlassGroupItem
              onPress={onNewThread}
              accessibilityLabel="New task with current settings"
              testID="thread-header-new"
            >
              <SymbolIcon
                name="square.and.pencil"
                fallback={SquarePen}
                size={19}
                color={iconColor}
              />
            </GlassGroupItem>
          ) : null}
          {onOpenOptions ? (
            <GlassGroupItem
              onPress={onOpenOptions}
              accessibilityLabel="Task options"
              testID="thread-header-options"
            >
              <SymbolIcon name="ellipsis" fallback={MoreHorizontal} size={19} color={iconColor} />
            </GlassGroupItem>
          ) : null}
        </GlassButtonGroup>
      }
    >
      {children}
    </FloatingHeader>
  )
})

const styles = StyleSheet.create((theme) => ({
  titlePressable: {
    flexShrink: 1,
    minWidth: 0,
    height: GLASS_CONTROL_SIZE,
  },
  titleCapsule: {
    flex: 1,
  },
  titleContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[1.5],
    paddingLeft: theme.spacing[4],
    paddingRight: theme.spacing[3],
  },
  titleText: {
    flexShrink: 1,
    minWidth: 0,
    justifyContent: 'center',
  },
  subtitle: {
    // Two lines have to share a 44pt capsule; keep the caption snug.
    lineHeight: theme.fontSize.xs * 1.2,
    marginTop: -1,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: theme.radius.full,
  },
}))

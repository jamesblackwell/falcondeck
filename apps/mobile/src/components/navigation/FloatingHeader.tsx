import { memo, type ReactNode } from 'react'
import { View, type LayoutChangeEvent, type StyleProp, type ViewStyle } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { StyleSheet } from 'react-native-unistyles'

import { GLASS_CONTROL_SIZE, ScrollEdge } from '@/components/ui'

/** Height of the control row under the status bar. */
export const FLOATING_HEADER_ROW_HEIGHT = GLASS_CONTROL_SIZE + 8
/** How far the scroll edge fade reaches below the control row. */
const EDGE_OVERHANG = 22

/** Where floating content starts, before the header has measured itself. */
export function estimatedFloatingHeaderHeight(topInset: number) {
  return topInset + FLOATING_HEADER_ROW_HEIGHT
}

interface FloatingHeaderProps {
  /** Leading control, usually one glass circle. */
  left?: ReactNode
  /** Title area; takes the space between the leading and trailing controls. */
  center?: ReactNode
  /** Trailing controls, usually a glass group. */
  right?: ReactNode
  /** Banners and notices that float with the header, under the control row. */
  children?: ReactNode
  /** Background content fades into under the status bar. */
  edgeColor?: string
  /**
   * `inline` keeps the same glass controls in normal flow above the content,
   * for list screens whose pull-to-refresh must not hide behind the bar.
   */
  placement?: 'floating' | 'inline'
  onLayout?: (event: LayoutChangeEvent) => void
  style?: StyleProp<ViewStyle>
}

/**
 * The iOS 26 navigation bar shape: glass controls floating over the content,
 * which scrolls up underneath them and softens into the background at the
 * status bar instead of stopping at a hairline. Empty space passes touches
 * through, so drags and taps reach the list behind it.
 */
export const FloatingHeader = memo(function FloatingHeader({
  left,
  center,
  right,
  children,
  edgeColor,
  placement = 'floating',
  onLayout,
  style,
}: FloatingHeaderProps) {
  const floating = placement === 'floating'
  const insets = useSafeAreaInsets()
  const rowBottom = insets.top + FLOATING_HEADER_ROW_HEIGHT
  const edgeHeight = rowBottom + EDGE_OVERHANG

  return (
    <View
      pointerEvents="box-none"
      style={[floating ? styles.root : styles.inline, style]}
      onLayout={onLayout}
    >
      {/* Opaque under the clock, still mostly opaque behind the controls so
          text between the capsules cannot compete with the title, then gone
          a little below the row. */}
      {floating ? (
        <ScrollEdge
          edge="top"
          height={edgeHeight}
          color={edgeColor}
          stops={[
            [0, 1],
            [insets.top, 1],
            [insets.top + FLOATING_HEADER_ROW_HEIGHT * 0.5, 0.9],
            [rowBottom, 0.55],
            [edgeHeight, 0],
          ]}
        />
      ) : null}
      <View
        pointerEvents="box-none"
        style={[
          styles.row,
          {
            marginTop: insets.top,
            paddingLeft: Math.max(insets.left, 0) + 16,
            paddingRight: Math.max(insets.right, 0) + 16,
          },
        ]}
      >
        {left ? <View style={styles.side}>{left}</View> : null}
        <View pointerEvents="box-none" style={styles.center}>
          {center}
        </View>
        {right ? <View style={styles.side}>{right}</View> : null}
      </View>
      {children ? (
        <View pointerEvents="box-none" style={styles.accessories}>
          {children}
        </View>
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  root: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 10,
  },
  inline: {
    zIndex: 10,
    paddingBottom: theme.spacing[1],
  },
  row: {
    height: FLOATING_HEADER_ROW_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
  },
  side: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
  },
  center: {
    flex: 1,
    minWidth: 0,
    flexDirection: 'row',
    alignItems: 'center',
  },
  accessories: {
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
}))

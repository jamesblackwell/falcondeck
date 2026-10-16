import { Children, Fragment, isValidElement, memo, type ReactNode } from 'react'
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { ChevronRight } from 'lucide-react-native'

import { SymbolIcon } from './SymbolIcon'
import { Text } from './Text'

/** Tints a row's icon and label for what the action does. */
export type SheetRowTone = 'default' | 'accent' | 'info' | 'danger'

interface SheetGroupProps {
  children: ReactNode
  style?: StyleProp<ViewStyle>
}

/**
 * Rows grouped on one rounded card with hairline separators — the inset
 * grouped list iOS uses inside sheets. Separators are inserted between the
 * children that actually render, so conditional rows need no bookkeeping.
 */
export const SheetGroup = memo(function SheetGroup({ children, style }: SheetGroupProps) {
  const rows = Children.toArray(children).filter(isValidElement)
  if (rows.length === 0) return null
  return (
    <View style={[styles.group, style]}>
      {rows.map((row, index) => (
        <Fragment key={row.key ?? index}>
          {index > 0 ? <View style={styles.separator} /> : null}
          {row}
        </Fragment>
      ))}
    </View>
  )
})

interface SheetRowProps {
  label: string
  /** Leading glyph, sized and coloured by the row. */
  icon?: (color: string) => ReactNode
  tone?: SheetRowTone
  /** Shows a chevron: the row opens something rather than acting. */
  navigates?: boolean
  onPress?: () => void
  disabled?: boolean
  accessibilityLabel?: string
  accessibilityHint?: string
  testID?: string
}

/** One action in a {@link SheetGroup}. */
export const SheetRow = memo(function SheetRow({
  label,
  icon,
  tone = 'default',
  navigates = false,
  onPress,
  disabled = false,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: SheetRowProps) {
  const { theme } = useUnistyles()
  const color =
    tone === 'danger'
      ? theme.colors.danger.default
      : tone === 'info'
        ? theme.colors.info.default
        : tone === 'accent'
          ? theme.colors.accent.default
          : theme.colors.fg.secondary
  const textColor = tone === 'default' ? 'primary' : tone

  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled }}
      style={({ pressed }) => [
        styles.row,
        pressed && !disabled ? styles.rowPressed : null,
        disabled ? styles.rowDisabled : null,
      ]}
    >
      {icon ? <View style={styles.icon}>{icon(color)}</View> : null}
      <Text variant="label" color={textColor} style={styles.label} numberOfLines={1}>
        {label}
      </Text>
      {navigates ? (
        <SymbolIcon
          name="chevron.right"
          fallback={ChevronRight}
          size={12}
          weight="semibold"
          color={theme.colors.fg.faint}
        />
      ) : null}
    </Pressable>
  )
})

const ROW_ICON_SLOT = 24

const styles = StyleSheet.create((theme) => ({
  group: {
    borderRadius: 20,
    borderCurve: 'continuous',
    overflow: 'hidden',
    backgroundColor: theme.isDark ? 'rgba(255, 255, 255, 0.07)' : 'rgba(255, 255, 255, 0.78)',
  },
  separator: {
    height: StyleSheet.hairlineWidth,
    // Inset to the label, as iOS does, so the icons read as one column.
    marginLeft: theme.spacing[4] + ROW_ICON_SLOT + theme.spacing[3],
    backgroundColor: theme.isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(9, 9, 11, 0.09)',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[3],
    minHeight: 50,
    paddingHorizontal: theme.spacing[4],
  },
  rowPressed: {
    backgroundColor: theme.isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(9, 9, 11, 0.05)',
  },
  rowDisabled: {
    opacity: 0.5,
  },
  icon: {
    width: ROW_ICON_SLOT,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    flex: 1,
  },
}))

import { Children, isValidElement, memo, type ReactNode } from 'react'
import { View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'

import { Card, Text } from '@/components/ui'

export const SettingsSection = memo(function SettingsSection({
  title,
  footer,
  children,
}: {
  title?: string
  footer?: string
  children: ReactNode
}) {
  // The section owns the hairlines, not the rows: a row that drew its own
  // bottom border doubled up with the card's edge on the last row, and left a
  // separator dangling under it when a later row was conditionally hidden.
  const rows = Children.toArray(children)

  return (
    <View style={styles.section}>
      {title ? (
        <Text variant="caption" color="muted" weight="medium" style={styles.title}>
          {title.toUpperCase()}
        </Text>
      ) : null}
      <Card variant="flat" style={styles.card}>
        {rows.map((row, index) => (
          <View
            key={isValidElement(row) ? row.key : index}
            style={index > 0 ? styles.divider : undefined}
          >
            {row}
          </View>
        ))}
      </Card>
      {footer ? (
        <Text variant="caption" color="muted" style={styles.footer}>{footer}</Text>
      ) : null}
    </View>
  )
})

export const settingsPageStyles = StyleSheet.create((theme) => ({
  container: { flex: 1, backgroundColor: theme.colors.surface[0] },
  content: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[5],
    gap: theme.spacing[5],
  },
  error: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.danger.muted,
  },
}))

const styles = StyleSheet.create((theme) => ({
  section: { gap: theme.spacing[2] },
  title: { paddingHorizontal: theme.spacing[2], letterSpacing: 0.8 },
  card: { gap: 0 },
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.colors.border.default,
  },
  footer: { paddingHorizontal: theme.spacing[2], lineHeight: theme.fontSize.xs * theme.lineHeight.relaxed },
}))

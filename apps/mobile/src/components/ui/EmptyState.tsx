import { memo } from 'react'
import { View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'

import { Text } from './Text'

interface EmptyStateProps {
  icon?: React.ReactNode
  title: string
  description?: string
}

export const EmptyState = memo(function EmptyState({
  icon,
  title,
  description,
}: EmptyStateProps) {
  return (
    <View style={styles.container}>
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      <Text variant="label" color="secondary" weight="semibold">
        {title}
      </Text>
      {description ? (
        <Text variant="caption" color="muted" style={styles.description}>
          {description}
        </Text>
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: theme.spacing[10],
    paddingHorizontal: theme.spacing[6],
    gap: theme.spacing[2],
  },
  icon: {
    marginBottom: theme.spacing[2],
  },
  description: {
    textAlign: 'center',
    maxWidth: 260,
  },
}))

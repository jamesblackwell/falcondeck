import { memo } from 'react'
import { View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'

import type { ConversationItem } from '@falcondeck/client-core'

import { Text } from '@/components/ui'

type ServiceItem = Extract<ConversationItem, { kind: 'service' }>

interface ServiceBlockProps {
  item: ServiceItem
}

export const ServiceBlock = memo(function ServiceBlock({ item }: ServiceBlockProps) {
  return (
    <View style={styles.row}>
      <Text variant="caption" color="muted" style={styles.text}>
        {item.message}
      </Text>
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  row: {
    alignItems: 'center',
    paddingVertical: theme.spacing[2],
  },
  text: {
    textAlign: 'center',
    fontStyle: 'italic',
  },
}))

import { memo } from 'react'
import { ScrollView, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { Layers } from 'lucide-react-native'

import type { ConversationLiveActivityGroup } from '@falcondeck/client-core'

import { Text } from '@/components/ui'
import { ToolCallBlock } from './ToolCallBlock'

interface LiveActivityLaneProps {
  groups: ConversationLiveActivityGroup[]
}

export const LiveActivityLane = memo(function LiveActivityLane({
  groups,
}: LiveActivityLaneProps) {
  const { theme } = useUnistyles()

  if (groups.length === 0) return null

  return (
    <View style={styles.container}>
      <ScrollView style={styles.scrollArea} contentContainerStyle={styles.scrollContent} nestedScrollEnabled>
        {groups.map((group) => (
          <View key={group.id} style={styles.group}>
            <View style={styles.groupHeader}>
              <Layers size={14} color={theme.colors.fg.muted} />
              <View style={styles.groupHeaderText}>
                <Text variant="caption" color="secondary">
                  {group.summary.title}
                </Text>
                {group.summary.subtitle ? (
                  <Text variant="caption" color="muted" size="2xs" numberOfLines={1}>
                    {group.summary.subtitle}
                  </Text>
                ) : null}
              </View>
            </View>
            <View style={styles.groupBody}>
              {group.items.map((item) => (
                <ToolCallBlock
                  key={item.id}
                  item={item}
                  defaultOpen={false}
                  suppressDetail
                  variant="row"
                />
              ))}
            </View>
          </View>
        ))}
      </ScrollView>
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  // Floats above the composer as one opaque card: tool rows are content and
  // must stay legible over the transcript scrolling behind them.
  container: {
    maxHeight: 220,
    marginHorizontal: 10,
    marginBottom: theme.spacing[2],
    borderRadius: 22,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.emphasis,
    backgroundColor: theme.colors.surface[1],
    overflow: 'hidden',
  },
  scrollArea: {
    maxHeight: 220,
  },
  scrollContent: {
    padding: theme.spacing[2],
    gap: theme.spacing[2],
  },
  group: {
    borderWidth: 1,
    borderColor: theme.colors.border.subtle,
    borderRadius: theme.radius.lg,
    borderCurve: 'continuous',
    backgroundColor: theme.colors.surface[2],
    overflow: 'hidden',
  },
  groupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border.subtle,
  },
  groupHeaderText: {
    flex: 1,
    gap: 2,
  },
  groupBody: {
    paddingVertical: theme.spacing[1],
  },
}))

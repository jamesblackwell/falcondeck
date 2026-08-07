import { memo, useState } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { ChevronRight, Loader2 } from 'lucide-react-native'

import { formatWorkDuration, type WorkSessionEntry } from '@falcondeck/client-core'

import { Text } from '@/components/ui'
import { ToolCallBlock } from './ToolCallBlock'
import { ConnectedReasoningBlock } from './ReasoningBlock'

type WorkSessionBlockProps = {
  items: WorkSessionEntry[]
  running: boolean
  startedAt: string
  completedAt: string | null
}

/** One buried run of tool work: "Working…" while live, "Worked for 2m 14s"
    once done, expanding to the individual tool rows. */
export const WorkSessionBlock = memo(function WorkSessionBlock({
  items,
  running,
  startedAt,
  completedAt,
}: WorkSessionBlockProps) {
  const [open, setOpen] = useState(false)
  const { theme } = useUnistyles()

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((current) => !current)}
        style={styles.row}
      >
        {running ? <Loader2 size={14} color={theme.colors.accent.default} /> : null}
        <Text variant="label" color="muted">
          {running ? 'Working…' : `Worked for ${formatWorkDuration(startedAt, completedAt ?? startedAt)}`}
        </Text>
        <ChevronRight
          size={14}
          style={open ? styles.chevronOpen : undefined}
          color={theme.colors.fg.muted}
        />
      </Pressable>
      {open ? (
        <View style={styles.detail}>
          {items.map((item) =>
            item.kind === 'reasoning' ? (
              <ConnectedReasoningBlock key={item.id} item={item} nested />
            ) : (
              <ToolCallBlock key={item.id} item={item} defaultOpen={false} suppressDetail={false} />
            ),
          )}
        </View>
      ) : null}
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[1.5],
    paddingVertical: theme.spacing[1],
  },
  chevronOpen: {
    transform: [{ rotate: '90deg' }],
  },
  detail: {
    marginTop: theme.spacing[1],
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border.subtle,
    paddingLeft: theme.spacing[3],
    gap: theme.spacing[1],
  },
}))

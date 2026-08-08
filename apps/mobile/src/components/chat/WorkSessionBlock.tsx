import { memo, useState } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { ChevronRight } from 'lucide-react-native'

import { formatWorkDuration, type WorkSessionEntry } from '@falcondeck/client-core'

import { Spinner, Text } from '@/components/ui'
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
  // FlashList recycles instances across blocks; without this render-phase
  // reset an expanded session stays expanded when the cell is reused for a
  // different one, so rows change height and flicker while scrolling.
  const sessionKey = items[0]?.id
  const [appliedSessionKey, setAppliedSessionKey] = useState(sessionKey)
  if (appliedSessionKey !== sessionKey) {
    setAppliedSessionKey(sessionKey)
    setOpen(false)
  }
  const { theme } = useUnistyles()

  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((current) => !current)}
        style={styles.row}
      >
        {running ? <Spinner size={theme.iconSize.xs} color={theme.colors.accent.default} /> : null}
        <Text variant="label" color="muted">
          {running ? 'Working…' : `Worked for ${formatWorkDuration(startedAt, completedAt ?? startedAt)}`}
        </Text>
        <ChevronRight
          size={theme.iconSize.xs}
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
              <ToolCallBlock
                key={item.id}
                item={item}
                defaultOpen={false}
                suppressDetail={false}
                nested
              />
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
    // Sits on the transcript's content column, in line with message text
    // and the thinking indicator it trades places with.
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[1],
    // The painted row is short; keep the tap target at the HIG minimum.
    minHeight: theme.minTouchTarget,
  },
  chevronOpen: {
    transform: [{ rotate: '90deg' }],
  },
  detail: {
    // The rail sits on the content edge, like a reasoning block's rule;
    // nested rows hang from it instead of the screen edge.
    marginHorizontal: theme.spacing[4],
    marginTop: theme.spacing[1],
    borderLeftWidth: 1,
    borderLeftColor: theme.colors.border.subtle,
    paddingLeft: theme.spacing[3],
    gap: theme.spacing[1],
  },
}))

import { memo } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'

import type { ComposerSuggestion, ComposerSuggestionOffer } from '@falcondeck/client-core'

import { NativeSheet, Text } from '@/components/ui'

interface ComposerSuggestionSheetProps {
  offer: ComposerSuggestionOffer | null
  onSubmit: (suggestion: ComposerSuggestion) => void
  onClose: () => void
}

/** Every offered next action, so the alternatives behind the pill's chevron
    stay reachable on a touch target rather than a hover menu. */
export const ComposerSuggestionSheet = memo(function ComposerSuggestionSheet({
  offer,
  onSubmit,
  onClose,
}: ComposerSuggestionSheetProps) {
  if (!offer) return null

  return (
    <NativeSheet
      onClose={onClose}
      accessibilityLabel="Close suggestions"
      contentStyle={styles.sheet}
    >
      <View style={styles.body}>
        <Text variant="label" color="primary" weight="semibold">
          Suggested next steps
        </Text>
        {offer.actions.map((suggestion) => (
          <Pressable
            key={suggestion.id}
            style={styles.row}
            onPress={() => {
              onClose()
              onSubmit(suggestion)
            }}
            accessibilityRole="button"
            accessibilityLabel={suggestion.label}
            accessibilityHint={suggestion.description ?? 'Sends this as your next message'}
          >
            <Text color="primary" weight="medium">
              {suggestion.label}
            </Text>
            {suggestion.description ? (
              <Text variant="caption" size="xs" color="muted">
                {suggestion.description}
              </Text>
            ) : null}
          </Pressable>
        ))}
      </View>
    </NativeSheet>
  )
})

const styles = StyleSheet.create((theme) => ({
  sheet: {
    paddingHorizontal: theme.spacing[4],
  },
  body: {
    gap: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  row: {
    gap: theme.spacing[0.5],
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    borderRadius: theme.radius.lg,
    borderCurve: 'continuous',
    backgroundColor: theme.colors.surface[2],
  },
}))

import { memo } from 'react'
import { Pressable, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { ChevronUp, Sparkles, X } from 'lucide-react-native'

import type { ComposerSuggestion, ComposerSuggestionOffer } from '@falcondeck/client-core'

import { GlassSurface, glassFillStrong, Text } from '@/components/ui'

interface ComposerSuggestionPillProps {
  offer: ComposerSuggestionOffer | null
  onSubmit: (suggestion: ComposerSuggestion) => void
  onShowAlternatives: () => void
  onDismiss: () => void
}

/**
 * One compact pill of agent-offered next actions, above the composer.
 *
 * Tapping the label submits the recommended action; the chevron opens the
 * rest in a bottom sheet; the cross hides the offer. It appears only once the
 * associated turn is idle, which `deriveComposerSuggestions` decides — this
 * component never inspects thread status itself.
 */
export const ComposerSuggestionPill = memo(function ComposerSuggestionPill({
  offer,
  onSubmit,
  onShowAlternatives,
  onDismiss,
}: ComposerSuggestionPillProps) {
  const { theme } = useUnistyles()

  if (!offer) return null

  const alternatives = offer.actions.length - 1

  return (
    <GlassSurface
      radius={18}
      intensity={70}
      highlight={false}
      style={styles.container}
      contentStyle={styles.content}
    >
      <View style={styles.row} accessibilityRole="menubar">
      <Pressable
        style={styles.primary}
        onPress={() => onSubmit(offer.primary)}
        hitSlop={{ top: 8, bottom: 8 }}
        accessibilityRole="button"
        accessibilityLabel={`Suggested next step: ${offer.primary.label}`}
        accessibilityHint={offer.primary.description ?? 'Sends this as your next message'}
      >
        <Sparkles size={theme.iconSize.xs} color={theme.colors.accent.default} />
        <Text variant="caption" size="xs" weight="semibold" color="secondary" numberOfLines={1}>
          {offer.primary.label}
        </Text>
      </Pressable>

      {alternatives > 0 ? (
        <Pressable
          style={styles.trailing}
          onPress={onShowAlternatives}
          hitSlop={{ top: 8, bottom: 8 }}
          accessibilityRole="button"
          accessibilityLabel={`Show ${alternatives} more suggestion${alternatives === 1 ? '' : 's'}`}
        >
          <ChevronUp size={theme.iconSize.xs} color={theme.colors.fg.muted} />
        </Pressable>
      ) : null}

      <Pressable
        style={styles.trailing}
        onPress={onDismiss}
        hitSlop={{ top: 8, bottom: 8, right: 8 }}
        accessibilityRole="button"
        accessibilityLabel="Dismiss suggestions"
      >
        <X size={theme.iconSize.xs} color={theme.colors.fg.muted} />
      </Pressable>
      </View>
    </GlassSurface>
  )
})

const styles = StyleSheet.create((theme) => ({
  // A small glass capsule floating above the composer, like the composer
  // itself; it reads as an offer attached to the input.
  container: {
    alignSelf: 'center',
    maxWidth: '92%',
    marginBottom: theme.spacing[2],
  },
  content: {
    minHeight: 36,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'stretch',
    minHeight: 36,
  },
  primary: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    gap: theme.spacing[1.5],
    paddingLeft: theme.spacing[3] + 2,
    paddingRight: theme.spacing[2],
  },
  trailing: {
    justifyContent: 'center',
    paddingHorizontal: 10,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: glassFillStrong(theme.isDark),
  },
}))

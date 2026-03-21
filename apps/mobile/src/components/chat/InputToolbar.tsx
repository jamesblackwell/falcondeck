import { memo, useCallback } from 'react'
import { View, Pressable } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'

import type { ModelSummary } from '@falcondeck/client-core'

import { Text } from '@/components/ui'

interface InputToolbarProps {
  models: ModelSummary[]
  selectedModel: string | null
  selectedEffort: string | null
  onSelectModel: (modelId: string | null) => void
  onSelectEffort: (effort: string | null) => void
}

const EFFORT_OPTIONS = ['low', 'medium', 'high'] as const

export const InputToolbar = memo(function InputToolbar({
  models,
  selectedModel,
  selectedEffort,
  onSelectModel,
  onSelectEffort,
}: InputToolbarProps) {
  const currentModel = models.find((m) => m.id === selectedModel) ?? models.find((m) => m.is_default)

  const cycleModel = useCallback(() => {
    if (models.length <= 1) return
    const currentIndex = models.findIndex((m) => m.id === (currentModel?.id ?? null))
    const nextIndex = (currentIndex + 1) % models.length
    onSelectModel(models[nextIndex]!.id)
  }, [models, currentModel, onSelectModel])

  return (
    <View style={styles.container}>
      {models.length > 0 ? (
        <Pressable style={styles.modelPill} onPress={cycleModel}>
          <Text variant="caption" color="secondary" size="2xs" numberOfLines={1}>
            {currentModel?.label ?? 'Model'}
          </Text>
        </Pressable>
      ) : null}
      <View style={styles.effortGroup}>
        {EFFORT_OPTIONS.map((effort) => {
          const isActive = selectedEffort === effort
          return (
            <Pressable
              key={effort}
              style={[styles.effortPill, isActive && styles.effortPillActive]}
              onPress={() => onSelectEffort(effort)}
            >
              <Text
                variant="caption"
                color={isActive ? 'accent' : 'muted'}
                size="2xs"
                weight={isActive ? 'semibold' : 'normal'}
              >
                {effort[0]!.toUpperCase() + effort.slice(1)}
              </Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    paddingBottom: theme.spacing[1],
  },
  modelPill: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface[3],
    borderRadius: theme.radius.full,
    maxWidth: 120,
  },
  effortGroup: {
    flexDirection: 'row',
    borderRadius: theme.radius.full,
    backgroundColor: theme.colors.surface[3],
    padding: 2,
  },
  effortPill: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.radius.full,
  },
  effortPillActive: {
    backgroundColor: theme.colors.surface[1],
  },
}))

import { memo, useCallback, useMemo, useState } from 'react'
import { View, Pressable, Modal } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { ChevronDown, Check } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'

import type { AgentProvider, ModelSummary } from '@falcondeck/client-core'

import { Text } from '@/components/ui'

interface InputToolbarProps {
  models: ModelSummary[]
  selectedModel: string | null
  selectedEffort: string | null
  effortOptions: string[]
  selectedProvider: AgentProvider
  showProviderSelector: boolean
  onSelectModel: (modelId: string | null) => void
  onSelectEffort: (effort: string | null) => void
  onSelectProvider: (provider: AgentProvider) => void
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const PROVIDERS: { value: AgentProvider; label: string }[] = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude' },
]

type SheetConfig = {
  title: string
  items: readonly { value: string; label: string }[]
  selected: string | null
  onSelect: (value: string) => void
} | null

export const InputToolbar = memo(function InputToolbar({
  models,
  selectedModel,
  selectedEffort,
  effortOptions,
  selectedProvider,
  showProviderSelector,
  onSelectModel,
  onSelectEffort,
  onSelectProvider,
}: InputToolbarProps) {
  const { theme } = useUnistyles()
  const [sheet, setSheet] = useState<SheetConfig>(null)

  const currentModel = selectedModel ? models.find((m) => m.id === selectedModel) : null
  const modelDisplayLabel = currentModel?.label ?? 'Default'

  const openModelSheet = useCallback(() => {
    const items = [
      { value: '__default__', label: 'Default' },
      ...models.map((m) => ({ value: m.id, label: m.label })),
    ]
    setSheet({
      title: 'Model',
      items,
      selected: selectedModel ?? '__default__',
      onSelect: (id) => {
        void Haptics.selectionAsync()
        onSelectModel(id === '__default__' ? null : id)
        setSheet(null)
      },
    })
  }, [models, selectedModel, onSelectModel])

  const effortItems = useMemo(
    () => effortOptions.map((e) => ({ value: e, label: capitalize(e) })),
    [effortOptions],
  )

  const openEffortSheet = useCallback(() => {
    setSheet({
      title: 'Reasoning Effort',
      items: effortItems,
      selected: selectedEffort,
      onSelect: (value) => {
        void Haptics.selectionAsync()
        onSelectEffort(value)
        setSheet(null)
      },
    })
  }, [effortItems, selectedEffort, onSelectEffort])

  const currentEffortLabel = capitalize(selectedEffort ?? 'medium')

  return (
    <>
      <View style={styles.container}>
        {showProviderSelector ? (
          <View style={styles.providerToggle}>
            {PROVIDERS.map((p) => {
              const active = p.value === selectedProvider
              return (
                <Pressable
                  key={p.value}
                  style={[styles.providerSegment, active && styles.providerSegmentActive]}
                  onPress={() => {
                    if (!active) {
                      void Haptics.selectionAsync()
                      onSelectProvider(p.value)
                    }
                  }}
                >
                  <Text
                    variant="caption"
                    color={active ? 'primary' : 'muted'}
                    size="2xs"
                    weight={active ? 'semibold' : 'normal'}
                  >
                    {p.label}
                  </Text>
                </Pressable>
              )
            })}
          </View>
        ) : null}

        {models.length > 0 ? (
          <Pressable style={styles.chip} onPress={openModelSheet}>
            <Text variant="caption" color="secondary" size="2xs" numberOfLines={1}>
              {modelDisplayLabel}
            </Text>
            <ChevronDown size={10} color={theme.colors.fg.muted} />
          </Pressable>
        ) : null}

        <Pressable style={styles.chip} onPress={openEffortSheet}>
          <Text variant="caption" color="secondary" size="2xs">
            {currentEffortLabel}
          </Text>
          <ChevronDown size={10} color={theme.colors.fg.muted} />
        </Pressable>
      </View>

      {sheet ? (
        <Modal transparent animationType="slide" onRequestClose={() => setSheet(null)}>
          <Pressable style={styles.backdrop} onPress={() => setSheet(null)} />
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />
            <Text variant="label" color="primary" weight="semibold" style={styles.sheetTitle}>
              {sheet.title}
            </Text>
            {sheet.items.map((item) => {
              const isSelected = item.value === sheet.selected
              return (
                <Pressable
                  key={item.value}
                  style={[styles.sheetItem, isSelected && styles.sheetItemSelected]}
                  onPress={() => sheet.onSelect(item.value)}
                >
                  <Text color={isSelected ? 'primary' : 'secondary'} size="sm">
                    {item.label}
                  </Text>
                  {isSelected ? <Check size={16} color={theme.colors.accent.default} /> : null}
                </Pressable>
              )
            })}
          </View>
        </Modal>
      ) : null}
    </>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
  },
  providerToggle: {
    flexDirection: 'row',
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.border.subtle,
    backgroundColor: theme.colors.surface[1],
    padding: 2,
  },
  providerSegment: {
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.radius.full,
  },
  providerSegmentActive: {
    backgroundColor: theme.colors.surface[3],
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    backgroundColor: theme.colors.surface[3],
    borderRadius: theme.radius.full,
  },
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  sheet: {
    backgroundColor: theme.colors.surface[1],
    borderTopLeftRadius: theme.radius['2xl'],
    borderTopRightRadius: theme.radius['2xl'],
    paddingBottom: theme.spacing[8],
    paddingHorizontal: theme.spacing[4],
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.colors.border.emphasis,
    alignSelf: 'center',
    marginTop: theme.spacing[2],
    marginBottom: theme.spacing[3],
  },
  sheetTitle: {
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[2],
  },
  sheetItem: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: theme.spacing[3],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.radius.lg,
  },
  sheetItemSelected: {
    backgroundColor: theme.colors.surface[2],
  },
}))

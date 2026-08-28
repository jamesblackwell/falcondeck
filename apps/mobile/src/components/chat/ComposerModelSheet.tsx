import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, ScrollView, TextInput, View } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { ArrowRight, Check, ChevronLeft } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'

import {
  filterOptionsByQuery,
  formatModelLabel,
  SEARCHABLE_OPTION_THRESHOLD,
  type AgentProvider,
  type ModelSummary,
  type ProviderOption,
} from '@falcondeck/client-core'

import { NativeSheet, ProviderIcon, Text } from '@/components/ui'

/** Leaves a row of context above the revealed selection. */
const SELECTED_REVEAL_INSET = 64
const MODEL_DEFAULT_VALUE = '__default__'

type SheetPanel = 'agent' | 'model' | 'handoff'

export function agentModelChipLabel(
  providerLabel: string,
  modelLabel: string | null,
): string {
  return modelLabel ? `${providerLabel} · ${modelLabel}` : providerLabel
}

export type ComposerModelSheetProps = {
  models: ModelSummary[]
  selectedModel: string | null
  onSelectModel: (modelId: string | null) => void
  selectedProvider: AgentProvider
  providers: readonly ProviderOption[]
  showProviderSelector: boolean
  onSelectProvider: (provider: AgentProvider) => void
  handoffProviders?: readonly ProviderOption[]
  onHandoffProviderSelect?: (provider: AgentProvider) => void
  handoffDisabledReason?: string | null
  modelsLoading?: boolean
  onClose: () => void
}

/**
 * Two-stage picker. A new thread starts on the agent list, then drills into
 * that agent's models. An existing thread skips the agent step and opens on
 * models; other agents are a nested handoff step off that list.
 */
export const ComposerModelSheet = memo(function ComposerModelSheet({
  models,
  selectedModel,
  onSelectModel,
  selectedProvider,
  providers,
  showProviderSelector,
  onSelectProvider,
  handoffProviders = [],
  onHandoffProviderSelect,
  handoffDisabledReason = null,
  modelsLoading = false,
  onClose,
}: ComposerModelSheetProps) {
  const { theme } = useUnistyles()
  const canSwitchAgent = showProviderSelector && providers.length > 1
  const canHandoff =
    !showProviderSelector &&
    handoffProviders.length > 0 &&
    Boolean(onHandoffProviderSelect)
  const [panel, setPanel] = useState<SheetPanel>(
    canSwitchAgent ? 'agent' : 'model',
  )
  const [query, setQuery] = useState('')
  const searchable = panel === 'model' && models.length >= SEARCHABLE_OPTION_THRESHOLD
  const visibleModels = useMemo(
    () =>
      searchable
        ? filterOptionsByQuery(
            models,
            query,
            (model) => `${model.label} ${model.id}`,
          )
        : models,
    [models, query, searchable],
  )
  const searching = searchable && query.trim().length > 0
  const selectedModelValue = selectedModel ?? MODEL_DEFAULT_VALUE
  const title =
    panel === 'agent'
      ? 'Agent'
      : panel === 'handoff'
        ? 'Continue in another harness'
        : 'Model'
  const showBack = panel === 'model' ? canSwitchAgent : panel === 'handoff'

  const listRef = useRef<ScrollView>(null)
  const selectedOffset = useRef<number | null>(null)
  const hasRevealed = useRef(false)
  const revealSelected = useCallback(() => {
    if (hasRevealed.current || selectedOffset.current === null) return
    hasRevealed.current = true
    listRef.current?.scrollTo({
      y: Math.max(0, selectedOffset.current - SELECTED_REVEAL_INSET),
      animated: false,
    })
  }, [])

  useEffect(() => {
    setQuery('')
    hasRevealed.current = false
    selectedOffset.current = null
  }, [panel, selectedProvider])

  const handleBack = useCallback(() => {
    setPanel(panel === 'handoff' ? 'model' : 'agent')
  }, [panel])

  const handleSelectModel = useCallback(
    (value: string) => {
      void Haptics.selectionAsync()
      onSelectModel(value === MODEL_DEFAULT_VALUE ? null : value)
      onClose()
    },
    [onClose, onSelectModel],
  )

  const handleSelectProvider = useCallback(
    (provider: AgentProvider) => {
      void Haptics.selectionAsync()
      if (provider !== selectedProvider) onSelectProvider(provider)
      setPanel('model')
    },
    [onSelectProvider, selectedProvider],
  )

  const handleHandoff = useCallback(
    (provider: AgentProvider) => {
      if (!onHandoffProviderSelect || handoffDisabledReason) return
      void Haptics.selectionAsync()
      onHandoffProviderSelect(provider)
      onClose()
    },
    [handoffDisabledReason, onClose, onHandoffProviderSelect],
  )

  const markSelectedOffset = useCallback(
    (y: number) => {
      selectedOffset.current = y
      requestAnimationFrame(revealSelected)
    },
    [revealSelected],
  )

  return (
    <NativeSheet
      onClose={onClose}
      accessibilityLabel="Close agent and model picker"
      contentStyle={styles.content}
    >
      <View style={styles.header}>
        {showBack ? (
          <Pressable
            onPress={handleBack}
            accessibilityRole="button"
            accessibilityLabel={
              panel === 'handoff' ? 'Back to models' : 'Back to agents'
            }
            hitSlop={8}
            style={styles.backButton}
          >
            <ChevronLeft
              size={theme.iconSize.md}
              color={theme.colors.fg.primary}
            />
          </Pressable>
        ) : null}
        <Text
          variant="label"
          color="primary"
          weight="semibold"
          style={styles.title}
        >
          {title}
        </Text>
      </View>
      {searchable ? (
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search models…"
          placeholderTextColor={theme.colors.fg.muted}
          selectionColor={theme.colors.accent.default}
          accessibilityLabel="Search models"
          accessibilityHint={`${visibleModels.length} ${visibleModels.length === 1 ? 'model' : 'models'}`}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          returnKeyType="done"
          style={styles.searchInput}
        />
      ) : null}
      <ScrollView
        ref={listRef}
        style={styles.list}
        bounces={false}
        keyboardShouldPersistTaps="handled"
        onContentSizeChange={revealSelected}
      >
        {panel === 'agent'
          ? providers.map((option) => {
              const selected = option.provider === selectedProvider
              return (
                <SheetRow
                  key={option.provider}
                  label={option.label}
                  selected={selected}
                  provider={option.provider}
                  trailing="arrow"
                  onLayout={selected ? markSelectedOffset : undefined}
                  onPress={() => handleSelectProvider(option.provider)}
                />
              )
            })
          : null}

        {panel === 'handoff'
          ? handoffProviders.map((option) => (
              <SheetRow
                key={option.provider}
                label={option.label}
                description={
                  handoffDisabledReason ??
                  'Creates a linked thread; this one stays unchanged'
                }
                disabled={Boolean(handoffDisabledReason)}
                provider={option.provider}
                trailing="arrow"
                onPress={() => handleHandoff(option.provider)}
              />
            ))
          : null}

        {panel === 'model' ? (
          <>
            {modelsLoading && models.length === 0 ? (
              <View style={styles.empty}>
                <Text variant="caption" color="muted">
                  Loading models…
                </Text>
              </View>
            ) : (
              <>
                <SheetRow
                  label="Default"
                  selected={selectedModelValue === MODEL_DEFAULT_VALUE}
                  onLayout={
                    selectedModelValue === MODEL_DEFAULT_VALUE
                      ? markSelectedOffset
                      : undefined
                  }
                  onPress={() => handleSelectModel(MODEL_DEFAULT_VALUE)}
                />
                {visibleModels.map((model) => {
                  const selected = model.id === selectedModelValue
                  return (
                    <SheetRow
                      key={model.id}
                      label={formatModelLabel(model.label)}
                      selected={selected}
                      onLayout={selected ? markSelectedOffset : undefined}
                      onPress={() => handleSelectModel(model.id)}
                    />
                  )
                })}
                {visibleModels.length === 0 && searching ? (
                  <Text
                    variant="caption"
                    color="muted"
                    accessibilityLiveRegion="polite"
                    style={styles.empty}
                  >
                    No models match “{query.trim()}”
                  </Text>
                ) : null}
              </>
            )}
            {canHandoff && !searching ? (
              <SheetRow
                label="Continue in another harness…"
                description={
                  handoffDisabledReason ??
                  'Creates a linked thread; this one stays unchanged'
                }
                disabled={Boolean(handoffDisabledReason)}
                trailing="arrow"
                onPress={() => {
                  if (handoffDisabledReason) return
                  void Haptics.selectionAsync()
                  setPanel('handoff')
                }}
              />
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </NativeSheet>
  )
})

const SheetRow = memo(function SheetRow({
  label,
  description,
  selected = false,
  disabled = false,
  provider,
  trailing,
  onPress,
  onLayout,
}: {
  label: string
  description?: string | null
  selected?: boolean
  disabled?: boolean
  provider?: AgentProvider
  trailing?: 'arrow'
  onPress: () => void
  onLayout?: (y: number) => void
}) {
  const { theme } = useUnistyles()
  const iconColor = disabled
    ? theme.colors.fg.faint
    : selected
      ? theme.colors.fg.primary
      : theme.colors.fg.secondary

  return (
    <Pressable
      style={[styles.item, selected ? styles.itemSelected : null]}
      onLayout={
        onLayout
          ? (event) => {
              onLayout(event.nativeEvent.layout.y)
            }
          : undefined
      }
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={description ?? undefined}
      accessibilityState={{
        disabled: Boolean(disabled),
        selected,
      }}
      onPress={onPress}
    >
      {provider ? (
        <ProviderIcon provider={provider} size={theme.iconSize.sm} color={iconColor} />
      ) : null}
      <View style={styles.itemBody}>
        <Text size="sm" color={disabled ? 'faint' : 'primary'}>
          {label}
        </Text>
        {description ? (
          <Text variant="caption" size="xs" color={disabled ? 'faint' : 'muted'}>
            {description}
          </Text>
        ) : null}
      </View>
      {selected ? (
        <Check size={theme.iconSize.sm} color={theme.colors.accent.default} />
      ) : null}
      {trailing === 'arrow' ? (
        <ArrowRight size={theme.iconSize.sm} color={theme.colors.fg.muted} />
      ) : null}
    </Pressable>
  )
})

const styles = StyleSheet.create((theme) => ({
  content: {
    paddingHorizontal: theme.spacing[4],
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[1],
    paddingRight: theme.spacing[10],
    paddingBottom: theme.spacing[2],
  },
  backButton: {
    width: theme.spacing[8],
    height: theme.spacing[8],
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flex: 1,
    paddingHorizontal: theme.spacing[2],
  },
  list: {
    maxHeight: 360,
  },
  searchInput: {
    minHeight: theme.minTouchTarget,
    marginHorizontal: theme.spacing[2],
    marginBottom: theme.spacing[2],
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surface[2],
    paddingHorizontal: theme.spacing[3],
    color: theme.colors.fg.primary,
    fontSize: theme.fontSize.sm,
  },
  empty: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[5],
    textAlign: 'center',
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing[3],
    minHeight: theme.minTouchTarget,
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.radius.lg,
  },
  itemSelected: {
    backgroundColor: theme.colors.surface[2],
  },
  itemBody: {
    flex: 1,
    gap: theme.spacing[0.5],
  },
}))

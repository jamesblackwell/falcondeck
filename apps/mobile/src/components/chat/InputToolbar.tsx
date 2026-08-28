import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { ChevronDown, Zap } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'

import {
  formatModelLabel,
  modelFastTier,
  NO_AGENT_CAPABILITIES,
  resolveServiceTier,
  type AgentCapabilitySummary,
  type AgentProvider,
  type ModelSummary,
  type ProviderOption,
} from '@falcondeck/client-core'

import {
  glassEdge,
  glassFill,
  OptionSheet,
  ProviderIcon,
  Text,
  type OptionSheetItem,
} from '@/components/ui'
import { triggerComposerSelectionHaptic } from '@/lib/haptics'

import {
  SANDBOX_DEFAULT_VALUE,
  permissionChipLabel,
  permissionModeItems,
  sandboxChipLabel,
  sandboxModeItems,
} from './composerModes'
import { agentModelChipLabel, ComposerModelSheet } from './ComposerModelSheet'

interface InputToolbarProps {
  models: ModelSummary[]
  selectedModel: string | null
  selectedEffort: string | null
  effortOptions: string[]
  selectedProvider: AgentProvider
  /** Providers the active workspace offers; defaults to the built-in pair. */
  providers?: ProviderOption[]
  showProviderSelector: boolean
  disabled?: boolean
  onSelectModel: (modelId: string | null) => void
  onSelectEffort: (effort: string | null) => void
  onSelectProvider: (provider: AgentProvider) => void
  /** Destinations offered behind the model sheet on an existing thread. */
  handoffProviders?: ProviderOption[]
  onHandoffProviderSelect?: (provider: AgentProvider) => void
  handoffDisabledReason?: string | null
  /** Tier id while fast mode is on; null is the provider's standard tier. */
  selectedServiceTier?: string | null
  onSelectServiceTier?: (tier: string | null) => void
  /** Drives which mode pickers appear; an agent with no modes shows none. */
  capabilities?: AgentCapabilitySummary
  selectedPermissionMode?: string | null
  selectedSandboxMode?: string | null
  onSelectPermissionMode?: (mode: string | null) => void
  onSelectSandboxMode?: (mode: string | null) => void
  /** Advanced modes can move into the composer's plus menu on narrow screens. */
  showModePickers?: boolean
  /** True while the harness catalog is still hydrating; shows placeholder chips. */
  modelsLoading?: boolean
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const DEFAULT_PROVIDERS: ProviderOption[] = [
  { provider: 'codex', label: 'Codex' },
  { provider: 'claude', label: 'Claude' },
  { provider: 'agy', label: 'Antigravity' },
]

type SheetConfig = {
  title: string
  items: readonly OptionSheetItem[]
  selected: string | null
  onSelect: (value: string) => void
} | null

export const InputToolbar = memo(function InputToolbar({
  models,
  selectedModel,
  selectedEffort,
  effortOptions,
  selectedProvider,
  providers = DEFAULT_PROVIDERS,
  showProviderSelector,
  disabled = false,
  onSelectModel,
  onSelectEffort,
  onSelectProvider,
  handoffProviders = [],
  onHandoffProviderSelect,
  handoffDisabledReason = null,
  selectedServiceTier = null,
  onSelectServiceTier,
  capabilities = NO_AGENT_CAPABILITIES,
  selectedPermissionMode = null,
  selectedSandboxMode = null,
  onSelectPermissionMode,
  onSelectSandboxMode,
  showModePickers = true,
  modelsLoading = false,
}: InputToolbarProps) {
  const [sheet, setSheet] = useState<SheetConfig>(null)
  const [modelSheetOpen, setModelSheetOpen] = useState(false)

  useEffect(() => {
    if (disabled) {
      setSheet(null)
      setModelSheetOpen(false)
    }
  }, [disabled])

  const currentModel = selectedModel ? models.find((m) => m.id === selectedModel) : null
  const providerLabel =
    providers.find((option) => option.provider === selectedProvider)?.label ??
    selectedProvider
  const modelDisplayLabel = currentModel
    ? formatModelLabel(currentModel.label)
    : models.length > 0 || modelsLoading
      ? modelsLoading && models.length === 0
        ? 'Loading…'
        : 'Default'
      : null
  const agentModelLabel = agentModelChipLabel(providerLabel, modelDisplayLabel)
  const showHandoff =
    handoffProviders.length > 0 && Boolean(onHandoffProviderSelect)
  const showAgentModelChip =
    models.length > 0 ||
    modelsLoading ||
    (showProviderSelector && providers.length > 0) ||
    showHandoff

  const openModelSheet = useCallback(() => {
    if (disabled) return
    triggerComposerSelectionHaptic()
    setSheet(null)
    setModelSheetOpen(true)
  }, [disabled])

  const effortItems = useMemo(
    () => effortOptions.map((e) => ({ value: e, label: capitalize(e) })),
    [effortOptions],
  )

  const openEffortSheet = useCallback(() => {
    if (disabled) return
    triggerComposerSelectionHaptic()

    setSheet({
      title: 'Reasoning effort',
      items: effortItems,
      selected: selectedEffort,
      onSelect: (value) => {
        onSelectEffort(value)
        setSheet(null)
      },
    })
  }, [disabled, effortItems, selectedEffort, onSelectEffort])

  const permissionModes = capabilities.permission_modes
  const sandboxModes = capabilities.sandbox_modes
  const showPermissionPicker = Boolean(onSelectPermissionMode) && permissionModes.length > 0
  const showSandboxPicker = Boolean(onSelectSandboxMode) && sandboxModes.length > 0

  const openPermissionSheet = useCallback(() => {
    if (disabled || !onSelectPermissionMode) return
    triggerComposerSelectionHaptic()

    setSheet({
      title: 'Permissions',
      items: permissionModeItems(permissionModes),
      // Keep `default` explicit: null means the app's permissive default while
      // this option intentionally restores the provider's safe default.
      selected: selectedPermissionMode ?? (permissionModes.includes('default') ? 'default' : null),
      onSelect: (value) => {
        onSelectPermissionMode(value)
        setSheet(null)
      },
    })
  }, [disabled, onSelectPermissionMode, permissionModes, selectedPermissionMode])

  const openSandboxSheet = useCallback(() => {
    if (disabled || !onSelectSandboxMode) return
    triggerComposerSelectionHaptic()

    setSheet({
      title: 'Sandbox',
      items: sandboxModeItems(sandboxModes),
      selected: selectedSandboxMode ?? SANDBOX_DEFAULT_VALUE,
      onSelect: (value) => {
        onSelectSandboxMode(value === SANDBOX_DEFAULT_VALUE ? null : value)
        setSheet(null)
      },
    })
  }, [disabled, onSelectSandboxMode, sandboxModes, selectedSandboxMode])

  const currentEffortLabel = capitalize(selectedEffort ?? 'medium')

  // Fast mode reads the tier off whichever model a send would actually use —
  // the explicit pick, or the provider default while the chip says "Default".
  const effectiveModel =
    currentModel ?? models.find((m) => m.is_default) ?? models[0] ?? null
  const fastTier = modelFastTier(effectiveModel)
  const fastActive = resolveServiceTier(selectedServiceTier, effectiveModel) !== null
  const handleFastPress = useCallback(() => {
    if (!onSelectServiceTier || !fastTier) return
    void Haptics.selectionAsync()
    onSelectServiceTier(fastActive ? null : fastTier.id)
  }, [fastActive, fastTier, onSelectServiceTier])

  return (
    <>
      {/* A scrolling row, not a wrapping one: Yoga wraps a shrinkable
          flexWrap container well before it actually runs out of space,
          stacking the chips beside the attach button. Overflowing chips
          scroll under the send button instead. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.scroll}
        contentContainerStyle={styles.container}
      >
        {/* New threads open the agent list first, then models. An existing
            thread skips straight to models. */}
        {showModePickers && showPermissionPicker ? (
          <Chip
            label={permissionChipLabel(selectedPermissionMode, permissionModes)}
            accessibilityLabel="Permission mode"
            disabled={disabled}
            onPress={openPermissionSheet}
          />
        ) : null}

        {showModePickers && showSandboxPicker ? (
          <Chip
            label={sandboxChipLabel(selectedSandboxMode)}
            accessibilityLabel="Sandbox mode"
            disabled={disabled}
            onPress={openSandboxSheet}
          />
        ) : null}

        {showAgentModelChip ? (
          <Chip
            label={agentModelLabel}
            accessibilityLabel="Agent and model"
            disabled={disabled || (modelsLoading && models.length === 0 && !showHandoff && !showProviderSelector)}
            onPress={openModelSheet}
            provider={selectedProvider}
          />
        ) : null}

        <Chip
          label={currentEffortLabel}
          accessibilityLabel="Reasoning effort"
          disabled={disabled || modelsLoading}
          onPress={openEffortSheet}
        />

        {/* A press-toggle, not a sheet: fast mode is boolean, and the chip's
            fill is its state. Hidden (not greyed) when the model has one
            speed — mobile chips already come and go per provider. */}
        {onSelectServiceTier && fastTier ? (
          <FastChip
            label={fastTier.name}
            active={fastActive}
            disabled={disabled}
            onPress={handleFastPress}
          />
        ) : null}
      </ScrollView>

      {sheet ? (
        <OptionSheet
          title={sheet.title}
          items={sheet.items}
          selected={sheet.selected}
          onSelect={sheet.onSelect}
          onClose={() => setSheet(null)}
        />
      ) : null}

      {modelSheetOpen ? (
        <ComposerModelSheet
          models={models}
          selectedModel={selectedModel}
          onSelectModel={onSelectModel}
          selectedProvider={selectedProvider}
          providers={providers}
          showProviderSelector={showProviderSelector}
          onSelectProvider={onSelectProvider}
          handoffProviders={handoffProviders}
          onHandoffProviderSelect={onHandoffProviderSelect}
          handoffDisabledReason={handoffDisabledReason}
          modelsLoading={modelsLoading}
          onClose={() => setModelSheetOpen(false)}
        />
      ) : null}
    </>
  )
})

const Chip = memo(function Chip({
  label,
  accessibilityLabel,
  disabled,
  onPress,
  provider,
}: {
  label: string
  accessibilityLabel: string
  disabled: boolean
  onPress: () => void
  provider?: AgentProvider
}) {
  const { theme } = useUnistyles()

  return (
    <Pressable
      style={[styles.chip, disabled && styles.controlDisabled]}
      accessibilityRole="button"
      accessibilityLabel={`${accessibilityLabel}: ${label}`}
      accessibilityState={{ disabled }}
      hitSlop={12}
      onPress={onPress}
      disabled={disabled}
    >
      {provider ? (
        <ProviderIcon
          provider={provider}
          size={theme.iconSize.xs}
          color={theme.colors.fg.secondary}
        />
      ) : null}
      <Text variant="caption" color="secondary" size="xs" numberOfLines={1}>
        {label}
      </Text>
      <ChevronDown size={theme.iconSize.xs} color={theme.colors.fg.muted} />
    </Pressable>
  )
})

const FastChip = memo(function FastChip({
  label,
  active,
  disabled,
  onPress,
}: {
  label: string
  active: boolean
  disabled: boolean
  onPress: () => void
}) {
  const { theme } = useUnistyles()
  const color = active ? theme.colors.accent.default : theme.colors.fg.muted

  return (
    <Pressable
      style={[styles.chip, active && styles.fastChipActive, disabled && styles.controlDisabled]}
      accessibilityRole="switch"
      accessibilityLabel="Fast mode"
      accessibilityState={{ disabled, checked: active }}
      hitSlop={12}
      onPress={onPress}
      disabled={disabled}
    >
      {/* The bolt fills in when the tier is on, so state survives without color. */}
      <Zap size={theme.iconSize.xs} color={color} fill={active ? color : 'none'} />
      <Text
        variant="caption"
        color={active ? 'primary' : 'secondary'}
        size="xs"
        numberOfLines={1}
        style={active ? { color } : undefined}
      >
        {label}
      </Text>
    </Pressable>
  )
})

const styles = StyleSheet.create((theme) => ({
  scroll: {
    flexShrink: 1,
    flexGrow: 0,
  },
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[1.5],
    // Painted height sits near the 44pt target; hitSlop covers the rest.
    minHeight: 34,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[1.5],
    backgroundColor: glassFill(theme.isDark),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: glassEdge(theme.isDark),
    borderRadius: theme.radius.full,
    // Chips shrink so a long mode label never pushes the send button off-row.
    flexShrink: 1,
  },
  fastChipActive: {
    backgroundColor: theme.colors.accent.muted,
  },
  controlDisabled: {
    opacity: 0.55,
  },
}))

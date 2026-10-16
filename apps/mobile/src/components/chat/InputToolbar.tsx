import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { ChevronDown, Zap } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'

import {
  formatModelLabel,
  modelFastTier,
  providerMark,
  NO_AGENT_CAPABILITIES,
  resolveServiceTier,
  resolveModelOption,
  type AgentCapabilitySummary,
  type ThreadIsolation,
  type AgentProvider,
  type ModelSummary,
  type ProviderOption,
} from '@falcondeck/client-core'

import {
  glassFill,
  OptionSheet,
  ProviderIcon,
  SymbolIcon,
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
  selectedIsolation?: ThreadIsolation
  onSelectIsolation?: (isolation: ThreadIsolation) => void
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
  selectedIsolation = 'project_folder',
  onSelectIsolation,
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

  const currentModel = resolveModelOption(models, selectedModel, selectedProvider)
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
  // The chip already carries the agent's own mark, so a known agent shows just
  // the model and the row keeps room for effort and fast mode. Agents without
  // a mark keep their name in words. Screen readers always hear both.
  const agentModelChipText =
    modelDisplayLabel && providerMark(selectedProvider)
      ? modelDisplayLabel
      : agentModelLabel
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

  const currentEffortLabel = capitalize(selectedEffort ?? 'default')

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

        {showProviderSelector && onSelectIsolation ? (
          <Chip
            label={selectedIsolation === 'isolated' ? 'Isolated copy' : 'Project folder'}
            accessibilityLabel="Task location"
            disabled={disabled}
            onPress={() => {
              if (disabled) return
              triggerComposerSelectionHaptic()
              setSheet({
                title: 'Start task in',
                items: [
                  { value: 'project_folder', label: 'Project folder', description: 'Work directly in the project folder.' },
                  { value: 'isolated', label: 'Isolated copy', description: 'Work in a separate copy on a new branch. Requires a Git repository.' },
                ],
                selected: selectedIsolation,
                onSelect: (value) => {
                  onSelectIsolation(value === 'isolated' ? 'isolated' : 'project_folder')
                  setSheet(null)
                },
              })
            }}
          />
        ) : null}

        {showAgentModelChip ? (
          <Chip
            label={agentModelChipText}
            accessibilityText={agentModelLabel}
            accessibilityLabel="Agent and model"
            disabled={disabled || (modelsLoading && models.length === 0 && !showHandoff && !showProviderSelector)}
            onPress={openModelSheet}
            provider={selectedProvider}
          />
        ) : null}

        {effortOptions.length > 0 ? (
          <Chip
            label={currentEffortLabel}
            accessibilityLabel="Reasoning effort"
            disabled={disabled || modelsLoading}
            onPress={openEffortSheet}
          />
        ) : null}

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
          selectedModel={currentModel?.id ?? selectedModel}
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
  accessibilityText,
  accessibilityLabel,
  disabled,
  onPress,
  provider,
}: {
  label: string
  /** Fuller wording for VoiceOver when the painted label is abbreviated. */
  accessibilityText?: string
  accessibilityLabel: string
  disabled: boolean
  onPress: () => void
  provider?: AgentProvider
}) {
  const { theme } = useUnistyles()

  return (
    <Pressable
      style={({ pressed }) => [
        styles.chip,
        pressed && !disabled ? styles.chipPressed : null,
        disabled && styles.controlDisabled,
      ]}
      accessibilityRole="button"
      accessibilityLabel={`${accessibilityLabel}: ${accessibilityText ?? label}`}
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
      <Text variant="caption" color="secondary" size="xs" weight="medium" numberOfLines={1} style={styles.chipLabel}>
        {label}
      </Text>
      <SymbolIcon
        name="chevron.down"
        fallback={ChevronDown}
        size={9}
        weight="bold"
        color={theme.colors.fg.muted}
      />
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
      style={({ pressed }) => [
        styles.chip,
        active ? styles.fastChipActive : styles.fastChipIdle,
        pressed && !disabled ? styles.chipPressed : null,
        disabled && styles.controlDisabled,
      ]}
      accessibilityRole="switch"
      accessibilityLabel="Fast mode"
      accessibilityState={{ disabled, checked: active }}
      hitSlop={12}
      onPress={onPress}
      disabled={disabled}
    >
      {/* The bolt fills in when the tier is on, so state survives without
          colour. Off, it is a bare bolt so the row keeps room for the model
          and effort; on, it names the tier it switched to. */}
      <SymbolIcon
        name={active ? 'bolt.fill' : 'bolt'}
        fallback={Zap}
        size={theme.iconSize.xs}
        weight="semibold"
        color={color}
        filled={active}
      />
      {active ? (
        <Text
          variant="caption"
          color="primary"
          size="xs"
          weight="medium"
          numberOfLines={1}
          style={{ color }}
        >
          {label}
        </Text>
      ) : null}
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
    gap: theme.spacing[1.5],
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    // Painted height matches the 36pt composer controls; hitSlop covers the
    // rest of the 44pt target. No hairline: on glass a fill reads as the
    // control, and an outline would draw a second edge inside the material.
    height: 36,
    paddingHorizontal: 10,
    backgroundColor: glassFill(theme.isDark),
    borderRadius: theme.radius.full,
    borderCurve: 'continuous',
    // Chips shrink so a long mode label never pushes the send button off-row.
    flexShrink: 1,
  },
  chipLabel: {
    flexShrink: 1,
  },
  chipPressed: {
    backgroundColor: theme.isDark ? 'rgba(255, 255, 255, 0.18)' : 'rgba(9, 9, 11, 0.1)',
  },
  fastChipActive: {
    backgroundColor: theme.colors.accent.muted,
  },
  fastChipIdle: {
    width: 36,
    paddingHorizontal: 0,
    justifyContent: 'center',
  },
  controlDisabled: {
    opacity: 0.55,
  },
}))

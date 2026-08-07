import { memo, useCallback, useEffect, useMemo, useState } from 'react'
import { View, Pressable } from 'react-native'
import { StyleSheet, useUnistyles } from 'react-native-unistyles'
import { ChevronDown } from 'lucide-react-native'
import * as Haptics from 'expo-haptics'

import {
  formatModelLabel,
  NO_AGENT_CAPABILITIES,
  type AgentCapabilitySummary,
  type AgentProvider,
  type ModelSummary,
  type ProviderOption,
} from '@falcondeck/client-core'

import { OptionSheet, Text, type OptionSheetItem } from '@/components/ui'

import {
  SANDBOX_DEFAULT_VALUE,
  permissionChipLabel,
  permissionModeItems,
  sandboxChipLabel,
  sandboxModeItems,
} from './composerModes'

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
  /** Drives which mode pickers appear; an agent with no modes shows none. */
  capabilities?: AgentCapabilitySummary
  selectedPermissionMode?: string | null
  selectedSandboxMode?: string | null
  onSelectPermissionMode?: (mode: string | null) => void
  onSelectSandboxMode?: (mode: string | null) => void
}

function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const DEFAULT_PROVIDERS: ProviderOption[] = [
  { provider: 'codex', label: 'Codex' },
  { provider: 'claude', label: 'Claude' },
]

const MODEL_DEFAULT_VALUE = '__default__'

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
  capabilities = NO_AGENT_CAPABILITIES,
  selectedPermissionMode = null,
  selectedSandboxMode = null,
  onSelectPermissionMode,
  onSelectSandboxMode,
}: InputToolbarProps) {
  const [sheet, setSheet] = useState<SheetConfig>(null)

  useEffect(() => {
    if (disabled) {
      setSheet(null)
    }
  }, [disabled])

  const currentModel = selectedModel ? models.find((m) => m.id === selectedModel) : null
  const modelDisplayLabel = currentModel ? formatModelLabel(currentModel.label) : 'Default'

  const openModelSheet = useCallback(() => {
    if (disabled) return

    setSheet({
      title: 'Model',
      items: [
        { value: MODEL_DEFAULT_VALUE, label: 'Default' },
        ...models.map((m) => ({ value: m.id, label: formatModelLabel(m.label) })),
      ],
      selected: selectedModel ?? MODEL_DEFAULT_VALUE,
      onSelect: (id) => {
        onSelectModel(id === MODEL_DEFAULT_VALUE ? null : id)
        setSheet(null)
      },
    })
  }, [disabled, models, selectedModel, onSelectModel])

  const effortItems = useMemo(
    () => effortOptions.map((e) => ({ value: e, label: capitalize(e) })),
    [effortOptions],
  )

  const openEffortSheet = useCallback(() => {
    if (disabled) return

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

    setSheet({
      title: 'Permissions',
      items: permissionModeItems(permissionModes),
      // `default` is the daemon's own id for "no override", so it round-trips
      // to null on the wire while still reading as a chosen option.
      selected: selectedPermissionMode ?? (permissionModes.includes('default') ? 'default' : null),
      onSelect: (value) => {
        onSelectPermissionMode(value === 'default' ? null : value)
        setSheet(null)
      },
    })
  }, [disabled, onSelectPermissionMode, permissionModes, selectedPermissionMode])

  const openSandboxSheet = useCallback(() => {
    if (disabled || !onSelectSandboxMode) return

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

  return (
    <>
      <View style={styles.container}>
        {showProviderSelector && providers.length > 0 ? (
          <View style={[styles.providerToggle, disabled && styles.controlDisabled]}>
            {providers.map((p) => {
              const active = p.provider === selectedProvider
              return (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${p.label} agent`}
                  accessibilityState={{ selected: active, disabled }}
                  key={p.provider}
                  style={[styles.providerSegment, active && styles.providerSegmentActive]}
                  disabled={disabled}
                  onPress={() => {
                    if (!active) {
                      void Haptics.selectionAsync()
                      onSelectProvider(p.provider)
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

        {/* Order matches the desktop composer: what the agent may do, then
            where it may do it, then which model and how hard it thinks. */}
        {showPermissionPicker ? (
          <Chip
            label={permissionChipLabel(selectedPermissionMode, permissionModes)}
            accessibilityLabel="Permission mode"
            disabled={disabled}
            onPress={openPermissionSheet}
          />
        ) : null}

        {showSandboxPicker ? (
          <Chip
            label={sandboxChipLabel(selectedSandboxMode)}
            accessibilityLabel="Sandbox mode"
            disabled={disabled}
            onPress={openSandboxSheet}
          />
        ) : null}

        {models.length > 0 ? (
          <Chip
            label={modelDisplayLabel}
            accessibilityLabel="Model"
            disabled={disabled}
            onPress={openModelSheet}
          />
        ) : null}

        <Chip
          label={currentEffortLabel}
          accessibilityLabel="Reasoning effort"
          disabled={disabled}
          onPress={openEffortSheet}
        />
      </View>

      {sheet ? (
        <OptionSheet
          title={sheet.title}
          items={sheet.items}
          selected={sheet.selected}
          onSelect={sheet.onSelect}
          onClose={() => setSheet(null)}
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
}: {
  label: string
  accessibilityLabel: string
  disabled: boolean
  onPress: () => void
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
      <Text variant="caption" color="secondary" size="2xs" numberOfLines={1}>
        {label}
      </Text>
      <ChevronDown size={10} color={theme.colors.fg.muted} />
    </Pressable>
  )
})

const styles = StyleSheet.create((theme) => ({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 1,
    flexWrap: 'wrap',
    gap: theme.spacing[2],
  },
  providerToggle: {
    flexDirection: 'row',
    borderRadius: theme.radius.full,
    borderWidth: 1,
    borderColor: theme.colors.border.subtle,
    backgroundColor: theme.colors.surface[1],
    padding: theme.spacing[0.5],
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
    // Chips shrink so a long mode label never pushes the send button off-row.
    flexShrink: 1,
  },
  controlDisabled: {
    opacity: 0.55,
  },
}))

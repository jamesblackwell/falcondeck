import { useCallback, useState } from 'react'
import { ScrollView } from 'react-native'

import {
  normalizePreferences,
  type ThinkingDisplay,
  type ToolDetailsMode,
  type UpdateConversationPreferences,
} from '@falcondeck/client-core'

import { ChoiceRow, PreferenceSwitch, SettingsSection, settingsPageStyles } from '@/components/settings'
import { Text } from '@/components/ui'
import { useRelayStore, useSessionStore } from '@/store'

const TOOL_DETAIL_OPTIONS: Array<{ value: ToolDetailsMode; label: string; description: string }> = [
  { value: 'collapsed', label: 'Hidden', description: 'Fold tool activity behind compact work summaries.' },
  { value: 'auto', label: 'Auto', description: 'Open high-signal activity and collapse repetitive inspection.' },
  { value: 'compact', label: 'Compact', description: 'Prefer grouped summaries while keeping artifacts visible.' },
  { value: 'expanded', label: 'Expanded', description: 'Keep raw tool output open for dense debugging.' },
  { value: 'hide_read_only_details', label: 'Hide read-only details', description: 'Summarize inspection without rendering raw output.' },
]

const THINKING_OPTIONS: Array<{ value: ThinkingDisplay; label: string; description: string }> = [
  { value: 'auto', label: 'Auto', description: 'Expand while streaming, then collapse when complete.' },
  { value: 'preview', label: 'Preview', description: 'Keep a short faded reasoning preview visible.' },
  { value: 'always_expanded', label: 'Always expanded', description: 'Show reasoning in full.' },
  { value: 'always_collapsed', label: 'Always collapsed', description: 'Keep reasoning closed until you open it.' },
]

export default function ConversationSettingsScreen() {
  const preferences = normalizePreferences(useSessionStore((state) => state.snapshot?.preferences))
  const setPreferences = useSessionStore((state) => state.setPreferences)
  const [isUpdating, setIsUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const update = useCallback(async (conversation: UpdateConversationPreferences) => {
    if (isUpdating) return
    setIsUpdating(true)
    setError(null)
    try {
      const updated = await useRelayStore.getState()._callRpc('preferences.update', { conversation })
      setPreferences(normalizePreferences(updated))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to update conversation settings')
    } finally {
      setIsUpdating(false)
    }
  }, [isUpdating, setPreferences])

  const current = preferences.conversation
  return (
    <ScrollView
      style={settingsPageStyles.container}
      contentContainerStyle={settingsPageStyles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      {error ? <Text variant="caption" color="danger" style={settingsPageStyles.error}>{error}</Text> : null}
      <SettingsSection title="Tool activity" footer="These preferences are stored by the connected daemon and shared with its other clients.">
        {TOOL_DETAIL_OPTIONS.map((option) => (
          <ChoiceRow
            key={option.value}
            label={option.label}
            description={option.description}
            selected={current.tool_details_mode === option.value}
            disabled={isUpdating}
            onPress={() => void update({ tool_details_mode: option.value })}
          />
        ))}
      </SettingsSection>

      <SettingsSection title="Thinking">
        {THINKING_OPTIONS.map((option) => (
          <ChoiceRow
            key={option.value}
            label={option.label}
            description={option.description}
            selected={current.thinking_display === option.value}
            disabled={isUpdating}
            onPress={() => void update({ thinking_display: option.value })}
          />
        ))}
      </SettingsSection>

      <SettingsSection title="Transcript behavior">
        <PreferenceSwitch
          label="Group read-only tool bursts"
          description="Combine consecutive searches and file reads into compact summaries."
          value={current.group_read_only_tools}
          disabled={isUpdating}
          onValueChange={(value) => void update({ group_read_only_tools: value })}
        />
        <PreferenceSwitch
          label="Auto-open errors"
          description="Applies to the summarizing views; the collapsed view always folds failed calls in with the rest of the tool activity."
          value={current.auto_expand.errors}
          disabled={isUpdating}
          onValueChange={(value) => void update({ auto_expand: { errors: value } })}
        />
        <PreferenceSwitch
          label="Auto-open failed tests"
          value={current.auto_expand.failed_tests}
          disabled={isUpdating}
          onValueChange={(value) => void update({ auto_expand: { failed_tests: value } })}
        />
      </SettingsSection>
    </ScrollView>
  )
}

import { useCallback, useRef, useState } from 'react'
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
  { value: 'collapsed', label: 'Hidden', description: 'Fold every tool call into a short work summary.' },
  { value: 'auto', label: 'Auto', description: 'Open what matters; fold routine reads and searches.' },
  { value: 'compact', label: 'Compact', description: 'Group the routine work, keep diffs and results in view.' },
  { value: 'expanded', label: 'Expanded', description: 'Keep every tool call open, output and all.' },
  { value: 'hide_read_only_details', label: 'Hide read-only details', description: 'Say what was read without showing the contents.' },
]

const THINKING_OPTIONS: Array<{ value: ThinkingDisplay; label: string; description: string }> = [
  { value: 'auto', label: 'Auto', description: 'Expand while streaming, then collapse when complete.' },
  { value: 'preview', label: 'Preview', description: 'Keep a short faded reasoning preview visible.' },
  { value: 'always_expanded', label: 'Always expanded', description: 'Show the full reasoning, always.' },
  { value: 'always_collapsed', label: 'Always collapsed', description: 'Keep reasoning closed until you tap it.' },
]

export default function ConversationSettingsScreen() {
  const preferences = normalizePreferences(useSessionStore((state) => state.snapshot?.preferences))
  const setPreferences = useSessionStore((state) => state.setPreferences)
  const [isUpdating, setIsUpdating] = useState(false)
  const updatingRef = useRef(false)
  const [error, setError] = useState<string | null>(null)

  const update = useCallback(async (conversation: UpdateConversationPreferences) => {
    if (updatingRef.current) return
    updatingRef.current = true
    setIsUpdating(true)
    setError(null)
    try {
      const updated = await useRelayStore.getState()._callRpc('preferences.update', { conversation })
      setPreferences(normalizePreferences(updated))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Failed to update conversation settings')
    } finally {
      updatingRef.current = false
      setIsUpdating(false)
    }
  }, [setPreferences])

  const current = preferences.conversation
  return (
    <ScrollView
      style={settingsPageStyles.container}
      contentContainerStyle={settingsPageStyles.content}
      contentInsetAdjustmentBehavior="automatic"
    >
      {error ? <Text variant="caption" color="danger" style={settingsPageStyles.error}>{error}</Text> : null}
      <SettingsSection title="Tool activity" footer="Stored on your desktop, so this applies everywhere you use FalconDeck.">
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
          label="Collapse long messages"
          description="Shorten walls of text you send to a few lines with Show more."
          value={current.collapse_long_user_messages}
          disabled={isUpdating}
          onValueChange={(value) => void update({ collapse_long_user_messages: value })}
        />
        <PreferenceSwitch
          label="Group repeated lookups"
          description="Combine back-to-back searches and file reads into one summary."
          value={current.group_read_only_tools}
          disabled={isUpdating}
          onValueChange={(value) => void update({ group_read_only_tools: value })}
        />
        <PreferenceSwitch
          label="Auto-open errors"
          description="Expand failed tool calls. Hidden keeps them folded away."
          value={current.auto_expand.errors}
          disabled={isUpdating}
          onValueChange={(value) => void update({ auto_expand: { errors: value } })}
        />
        <PreferenceSwitch
          label="Auto-open failed tests"
          description="Expand a test run as soon as something fails."
          value={current.auto_expand.failed_tests}
          disabled={isUpdating}
          onValueChange={(value) => void update({ auto_expand: { failed_tests: value } })}
        />
      </SettingsSection>
    </ScrollView>
  )
}

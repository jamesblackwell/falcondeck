import type { FalconDeckPreferences, UpdatePreferencesPayload } from '@falcondeck/client-core'
import { normalizePreferences } from '@falcondeck/client-core'
import {
  OptionCard,
  SegmentedControl,
  SettingList,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
  SwitchRow,
} from '@falcondeck/ui'

import { setFollowUpBehavior, useShortcutSettings } from '../../shortcuts'
import { THINKING_DISPLAY_OPTIONS, TOOL_DETAIL_OPTIONS } from './settings-utils'

type ConversationSettingsPanelProps = {
  preferences: FalconDeckPreferences | null
  onUpdatePreferences: (payload: UpdatePreferencesPayload) => void
}

export function ConversationSettingsPanel({
  preferences,
  onUpdatePreferences,
}: ConversationSettingsPanelProps) {
  const current = normalizePreferences(preferences)
  const shortcutSettings = useShortcutSettings()

  return (
    <SettingsPage>
      <SettingsPageHeader
        title="Conversations"
        description="How threads read and how sending behaves while an agent works. Shared with paired devices unless noted."
      />

      <SettingsSection
        title="Running follow-ups"
        description="What Send does while an agent is working. “Invert Queue / Steer” uses the other behavior once. Stored on this device."
      >
        <SegmentedControl
          ariaLabel="Default follow-up behavior"
          value={shortcutSettings.followUpBehavior}
          options={[
            { value: 'queue', label: 'Queue' },
            { value: 'steer', label: 'Steer' },
          ]}
          onChange={setFollowUpBehavior}
        />
      </SettingsSection>

      <SettingsSection
        title="Tool detail"
        description="How much raw tool activity a thread shows by default."
        contentClassName="grid gap-3 md:grid-cols-2"
      >
        {TOOL_DETAIL_OPTIONS.map((option) => (
          <OptionCard
            key={option.value}
            label={option.label}
            description={option.description}
            selected={current.conversation.tool_details_mode === option.value}
            onSelect={() =>
              onUpdatePreferences({ conversation: { tool_details_mode: option.value } })
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection
        title="Thinking"
        description="How reasoning blocks reveal themselves in the transcript. Stored on this device until the daemon carries the setting."
        contentClassName="grid gap-3 md:grid-cols-2"
      >
        {THINKING_DISPLAY_OPTIONS.map((option) => (
          <OptionCard
            key={option.value}
            label={option.label}
            description={option.description}
            selected={current.conversation.thinking_display === option.value}
            onSelect={() =>
              onUpdatePreferences({ conversation: { thinking_display: option.value } })
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection
        title="Auto-expand rules"
        description="Keep risky or high-signal artifacts obvious even when read-only chatter is grouped."
        contentClassName="pt-1"
      >
        <SettingList>
          <SwitchRow
            title="Group read-only tool bursts"
            description="Collapse consecutive file reads, searches, and similar inspection commands into a compact summary row."
            checked={current.conversation.group_read_only_tools}
            onCheckedChange={(next) =>
              onUpdatePreferences({ conversation: { group_read_only_tools: next } })
            }
          />
          <SwitchRow
            title="Collapse long messages you send"
            description="Clamp a pasted wall of text to a few lines with a Show more fade. Handoff prompts especially benefit."
            checked={current.conversation.collapse_long_user_messages}
            onCheckedChange={(next) =>
              onUpdatePreferences({ conversation: { collapse_long_user_messages: next } })
            }
          />
          <SwitchRow
            title="Show expand/collapse all controls"
            description="Expose quick thread-level controls above the conversation when tool cards are present."
            checked={current.conversation.show_expand_all_controls}
            onCheckedChange={(next) =>
              onUpdatePreferences({ conversation: { show_expand_all_controls: next } })
            }
          />
          <SwitchRow
            title="Auto-open approvals"
            description="Always expand approval-related artifacts so side effects stay obvious."
            checked={current.conversation.auto_expand.approvals}
            onCheckedChange={(next) =>
              onUpdatePreferences({ conversation: { auto_expand: { approvals: next } } })
            }
          />
          <SwitchRow
            title="Auto-open errors"
            description="Surface and expand failed calls immediately in the summarizing views. The collapsed view always folds them in — the agent still explains failures that blocked it."
            checked={current.conversation.auto_expand.errors}
            onCheckedChange={(next) =>
              onUpdatePreferences({ conversation: { auto_expand: { errors: next } } })
            }
          />
          <SwitchRow
            title="Auto-open failed tests"
            description="Keep failing test runs visible and expanded even when successful inspection bursts are collapsed."
            checked={current.conversation.auto_expand.failed_tests}
            onCheckedChange={(next) =>
              onUpdatePreferences({ conversation: { auto_expand: { failed_tests: next } } })
            }
          />
          <SwitchRow
            title="Auto-open the first diff"
            description="Keep the first patch in a thread visible even when inspection noise is collapsed."
            checked={current.conversation.auto_expand.first_diff}
            onCheckedChange={(next) =>
              onUpdatePreferences({ conversation: { auto_expand: { first_diff: next } } })
            }
          />
        </SettingList>
      </SettingsSection>

    </SettingsPage>
  )
}

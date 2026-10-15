import type { FalconDeckPreferences, UpdatePreferencesPayload } from '@falcondeck/client-core'
import { normalizePreferences } from '@falcondeck/client-core'
import {
  Button,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SettingList,
  SettingRow,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
  SwitchRow,
} from '@falcondeck/ui'
import { Volume2 } from 'lucide-react'

import {
  availableSounds,
  playSound,
  resolveSoundId,
  updateSoundSettings,
  useSoundSettings,
} from '../../sounds'

type NotificationsSettingsPanelProps = {
  preferences: FalconDeckPreferences | null
  onUpdatePreferences: (payload: UpdatePreferencesPayload) => void
}

export function NotificationsSettingsPanel({
  preferences,
  onUpdatePreferences,
}: NotificationsSettingsPanelProps) {
  const current = normalizePreferences(preferences)
  const soundSettings = useSoundSettings()
  const soundOptions = availableSounds()
  const selectedSoundId = resolveSoundId(soundSettings.soundId, soundOptions)
  const selectedSound = soundOptions.find((sound) => sound.id === selectedSoundId)

  return (
    <SettingsPage>
      <SettingsPageHeader
        title="Notifications"
        description="How FalconDeck gets your attention when an agent finishes or needs you."
      />

      <SettingsSection
        title="Alerts"
        description="Desktop and phone alerts. Stored by the daemon and synced to every paired client."
        contentClassName="pt-1"
      >
        <SettingList>
          <SwitchRow
            title="Agent attention notifications"
            description="Allow desktop and phone alerts for important agent events."
            checked={current.notifications.enabled}
            onCheckedChange={(next) => onUpdatePreferences({ notifications: { enabled: next } })}
          />
          <SwitchRow
            title="Completed turns"
            description="Notify when an agent finishes a turn you are not viewing."
            checked={current.notifications.notify_on_turn_complete}
            onCheckedChange={(next) =>
              onUpdatePreferences({ notifications: { notify_on_turn_complete: next } })
            }
          />
          <SwitchRow
            title="Approvals and questions"
            description="Notify when an agent is blocked waiting for your decision or answer."
            checked={current.notifications.notify_on_input_required}
            onCheckedChange={(next) =>
              onUpdatePreferences({ notifications: { notify_on_input_required: next } })
            }
          />
          <SwitchRow
            title="Failed turns"
            description="Notify when an agent turn ends with an error that may need investigation."
            checked={current.notifications.notify_on_error}
            onCheckedChange={(next) =>
              onUpdatePreferences({ notifications: { notify_on_error: next } })
            }
          />
          <SwitchRow
            title="Only push when away from desktop"
            description="Send phone alerts after two minutes without keyboard or mouse activity on your Mac, even if FalconDeck is left open. Desktop alerts still appear."
            checked={current.notifications.suppress_when_desktop_active}
            onCheckedChange={(next) =>
              onUpdatePreferences({ notifications: { suppress_when_desktop_active: next } })
            }
          />
        </SettingList>
      </SettingsSection>

      <SettingsSection
        title="Sounds"
        description="Heard on this computer only. Separate from attention notifications, and off until you turn it on."
        contentClassName="pt-1"
      >
        <SettingList>
          <SwitchRow
            title="Play a sound when a turn finishes"
            description="A short chime when an agent stops, even if FalconDeck is already in front."
            checked={soundSettings.enabled}
            onCheckedChange={(next) => {
              updateSoundSettings({ enabled: next })
              if (next) void playSound(selectedSoundId)
            }}
          />
          <SettingRow
            title="Sound"
            description={
              soundOptions.some((sound) => sound.kind === 'system')
                ? 'macOS system chimes, plus two small sounds shipped with FalconDeck.'
                : 'Short chimes shipped with FalconDeck.'
            }
            control={
              <div className="flex items-center gap-2">
                <Select
                  value={selectedSoundId}
                  onValueChange={(next) => {
                    updateSoundSettings({ soundId: next })
                    void playSound(next)
                  }}
                >
                  <SelectTrigger
                    aria-label="Turn complete sound"
                    className="h-8 w-[10.5rem] text-fg-primary"
                  >
                    <span className="truncate">{selectedSound?.label ?? 'Sound'}</span>
                  </SelectTrigger>
                  <SelectContent>
                    {soundOptions.map((sound) => (
                      <SelectItem
                        key={sound.id}
                        value={sound.id}
                        description={sound.description}
                      >
                        {sound.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Play sound"
                  onClick={() => void playSound(selectedSoundId)}
                >
                  <Volume2 className="h-4 w-4" />
                </Button>
              </div>
            }
          />
        </SettingList>
      </SettingsSection>

    </SettingsPage>
  )
}

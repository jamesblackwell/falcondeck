import type {
  FalconDeckPreferences,
  UpdatePreferencesPayload,
  WorkspaceSummary,
} from '@falcondeck/client-core'
import { normalizePreferences } from '@falcondeck/client-core'
import { SettingsPage, SettingsPageHeader, SettingsSection } from '@falcondeck/ui'

import type { DictationSetupToast } from '../DictationSetup'
import { OpenRouterKeyField } from './OpenRouterKeyField'
import { BackgroundModelsCard } from './BackgroundModelsCard'
import { TitleSettings } from './TitleSettings'

type ModelsKeysPanelProps = {
  baseUrl: string | null
  workspace?: WorkspaceSummary | null
  preferences: FalconDeckPreferences | null
  onUpdatePreferences: (payload: UpdatePreferencesPayload) => void
  onToast: (toast: DictationSetupToast) => void
}

/** The OpenRouter key and the small background models FalconDeck runs for
 * itself, as opposed to the agents you chat with. */
export function ModelsKeysPanel({
  baseUrl,
  workspace,
  preferences,
  onUpdatePreferences,
  onToast,
}: ModelsKeysPanelProps) {
  const current = normalizePreferences(preferences)
  return (
    <SettingsPage>
      <SettingsPageHeader
        title="Models & keys"
        description="The key and small helper models FalconDeck uses for its own features, separate from the agents you work with."
      />

      <SettingsSection
        title="OpenRouter"
        description="One optional key powers cloud transcription, transcript cleanup, voice rewrite, Read Aloud, and Suggest title. Only the audio or text for that action is sent."
      >
        <OpenRouterKeyField
          baseUrl={baseUrl}
          onToast={onToast}
          id="openrouter-key"
          hint="Stored on this computer. Paired devices use it through this Mac and never see the key."
        />
      </SettingsSection>

      <TitleSettings
        preferences={current}
        onUpdatePreferences={onUpdatePreferences}
      />

      <BackgroundModelsCard
        workspace={workspace}
        preferences={current}
        onUpdatePreferences={onUpdatePreferences}
      />
    </SettingsPage>
  )
}

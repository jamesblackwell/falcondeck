import {
  normalizePreferences,
  type FalconDeckPreferences,
  type UpdatePreferencesPayload,
} from "@falcondeck/client-core";
import { SettingsPage, SettingsPageHeader } from "@falcondeck/ui";

import { DictationSetup, type DictationSetupToast } from "../DictationSetup";
import { DictationHistoryCard } from "../DictationHistoryCard";
import { TitleSuggestionModelCard } from "./TitleSuggestionModelCard";

type SpeechSettingsPanelProps = {
  baseUrl: string | null;
  preferences: FalconDeckPreferences | null;
  onUpdatePreferences: (payload: UpdatePreferencesPayload) => void;
  onToast: (toast: DictationSetupToast) => void;
};

export function SpeechSettingsPanel({
  baseUrl,
  preferences,
  onUpdatePreferences,
  onToast,
}: SpeechSettingsPanelProps) {
  return (
    <SettingsPage>
      <SettingsPageHeader
        title="Speech"
        description="Dictate on this computer or configure the OpenRouter key used for title suggestions, voice rewrite, and cloud speech."
      />
      <DictationSetup baseUrl={baseUrl} onToast={onToast} />
      <TitleSuggestionModelCard
        preferences={normalizePreferences(preferences)}
        onUpdatePreferences={onUpdatePreferences}
      />
      <DictationHistoryCard baseUrl={baseUrl} onToast={onToast} />
    </SettingsPage>
  );
}

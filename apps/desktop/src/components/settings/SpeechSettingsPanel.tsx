import { SettingsPage, SettingsPageHeader } from "@falcondeck/ui";

import { DictationSetup, type DictationSetupToast } from "../DictationSetup";
import { DictationHistoryCard } from "../DictationHistoryCard";

type SpeechSettingsPanelProps = {
  baseUrl: string | null;
  onToast: (toast: DictationSetupToast) => void;
  onOpenModelsKeys?: () => void;
};

export function SpeechSettingsPanel({
  baseUrl,
  onToast,
  onOpenModelsKeys,
}: SpeechSettingsPanelProps) {
  return (
    <SettingsPage>
      <SettingsPageHeader
        title="Voice"
        description="Dictate into any app on this Mac, choose how speech is transcribed, and rewrite selected text by voice."
      />
      <DictationSetup
        baseUrl={baseUrl}
        onToast={onToast}
        onOpenModelsKeys={onOpenModelsKeys}
      />
      <DictationHistoryCard baseUrl={baseUrl} onToast={onToast} />
    </SettingsPage>
  );
}

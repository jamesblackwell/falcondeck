import { SettingsPage, SettingsPageHeader } from "@falcondeck/ui";

import { DictationSetup, type DictationSetupToast } from "../DictationSetup";

type SpeechSettingsPanelProps = {
  baseUrl: string | null;
  onToast: (toast: DictationSetupToast) => void;
};

export function SpeechSettingsPanel({
  baseUrl,
  onToast,
}: SpeechSettingsPanelProps) {
  return (
    <SettingsPage>
      <SettingsPageHeader
        title="Speech"
        description="Dictate on this computer or configure cloud transcription for paired devices."
      />
      <DictationSetup baseUrl={baseUrl} onToast={onToast} />
    </SettingsPage>
  );
}

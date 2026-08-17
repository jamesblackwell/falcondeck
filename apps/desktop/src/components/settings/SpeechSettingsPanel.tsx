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
    <div className="space-y-6">
      <div>
        <h1 className="text-[length:var(--fd-text-2xl)] font-semibold text-fg-primary">
          Speech
        </h1>
        <p className="mt-2 text-[length:var(--fd-text-sm)] text-fg-muted">
          Dictate anywhere on your Mac or configure cloud transcription for
          paired devices.
        </p>
      </div>
      <DictationSetup baseUrl={baseUrl} onToast={onToast} />
    </div>
  );
}

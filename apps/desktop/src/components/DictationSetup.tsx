import { useCallback, useEffect, useState } from "react";

import { createDaemonApiClient } from "@falcondeck/client-core";
import {
  ActivityDiamond,
  Badge,
  Button,
  Field,
  Input,
  SegmentedControl,
  SettingList,
  SettingsSection,
  SwitchRow,
} from "@falcondeck/ui";
import { ExternalLink, KeyRound, ShieldCheck, Trash2 } from "lucide-react";

import {
  readDictationAudioDevices,
  readDictationPermissions,
  nextRequiredDictationPermission,
  requestDictationPermission,
  useDictationSettings,
  writeDictationSettings,
  type DictationAudioDevice,
  type DictationPermission,
  type DictationPermissionStatus,
  type DictationSettings,
} from "../dictation";
import { isTauriDesktop } from "../api";

export type DictationSetupToast = {
  variant: "success" | "danger" | "warning" | "default";
  title: string;
  description?: string;
};

type SpeechModel = { id: string; name: string };

type DictationSetupProps = {
  baseUrl: string | null;
  onToast: (toast: DictationSetupToast) => void;
  compact?: boolean;
};

const SELECT_CLASS =
  "fd-focus h-9 w-full max-w-md rounded-[var(--fd-radius-md)] border border-border-default bg-surface-1 px-3 text-[length:var(--fd-text-sm)] text-fg-primary";

const PERMISSION_LABELS: Record<DictationPermission, string> = {
  microphone: "microphone access",
  speech_recognition: "Speech Recognition",
  accessibility: "Accessibility",
};

export function DictationSetup({
  baseUrl,
  onToast,
  compact = false,
}: DictationSetupProps) {
  const settings = useDictationSettings();
  const [permissions, setPermissions] =
    useState<DictationPermissionStatus | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [models, setModels] = useState<SpeechModel[]>([]);
  const [audioDevices, setAudioDevices] = useState<DictationAudioDevice[]>([]);

  const updateSettings = useCallback(
    (patch: Partial<DictationSettings>) =>
      writeDictationSettings({ ...settings, ...patch }),
    [settings],
  );

  const refreshPermissions = useCallback(async () => {
    setPermissions(await readDictationPermissions());
  }, []);

  const refreshAudioDevices = useCallback(async () => {
    try {
      setAudioDevices(await readDictationAudioDevices());
    } catch {
      setAudioDevices([]);
    }
  }, []);

  useEffect(() => {
    if (!isTauriDesktop()) return;
    void refreshPermissions();
    void refreshAudioDevices();
  }, [refreshAudioDevices, refreshPermissions]);

  const loadCredential = useCallback(async () => {
    if (!baseUrl) return;
    try {
      setConfigured(
        (await createDaemonApiClient(baseUrl).speechCredentialStatus())
          .configured,
      );
    } catch {
      setConfigured(null);
    }
  }, [baseUrl]);

  useEffect(() => {
    void loadCredential();
  }, [loadCredential]);

  useEffect(() => {
    if (!baseUrl || settings.provider !== "open_router") return;
    void fetch(`${baseUrl}/api/speech/models`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Model discovery failed");
        return response.json() as Promise<SpeechModel[]>;
      })
      .then(setModels)
      .catch(() => setModels([]));
  }, [baseUrl, settings.provider]);

  const nextPermission = permissions
    ? nextRequiredDictationPermission(permissions, settings.provider)
    : null;

  const requestPermission = async () => {
    if (!nextPermission) return;
    setPermissionBusy(true);
    try {
      await requestDictationPermission(nextPermission);
      window.setTimeout(() => void refreshPermissions(), 600);
      window.setTimeout(() => void refreshPermissions(), 1800);
      if (nextPermission === "microphone") {
        window.setTimeout(() => void refreshAudioDevices(), 1800);
      }
    } catch (error) {
      onToast({
        variant: "danger",
        title: `Could not request ${PERMISSION_LABELS[nextPermission]}`,
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setPermissionBusy(false);
    }
  };

  const setEnabled = (enabled: boolean) => {
    updateSettings({ enabled });
  };

  const saveKey = async () => {
    const cleaned = apiKey.trim();
    if (!baseUrl || !cleaned) return;
    setCredentialBusy(true);
    try {
      const status =
        await createDaemonApiClient(baseUrl).saveSpeechCredential(cleaned);
      setConfigured(status.configured);
      setApiKey("");
      onToast({
        variant: "success",
        title: "OpenRouter key saved",
        description: "The key is stored only on this computer.",
      });
    } catch (error) {
      onToast({
        variant: "danger",
        title: "Could not save OpenRouter key",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCredentialBusy(false);
    }
  };

  const removeKey = async () => {
    if (!baseUrl) return;
    setCredentialBusy(true);
    try {
      await createDaemonApiClient(baseUrl).deleteSpeechCredential();
      setConfigured(false);
      setApiKey("");
      onToast({ variant: "success", title: "OpenRouter key removed" });
    } catch (error) {
      onToast({
        variant: "danger",
        title: "Could not remove OpenRouter key",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setCredentialBusy(false);
    }
  };

  const permissionsReady =
    permissions?.microphone === "granted" &&
    permissions.accessibility &&
    (settings.provider !== "system" ||
      permissions.speechRecognition === "granted");
  const defaultAudioDeviceName = audioDevices.find(
    (device) => device.isDefault,
  )?.name;

  const permissionsSupported = isTauriDesktop() && permissions?.supported;

  return (
    <div className={compact ? "space-y-4" : "space-y-5"}>
      <SettingsSection
        title="Desktop dictation"
        description="Dictate into the app under your cursor while FalconDeck is running. Audio is deleted after a confirmed transcript is pasted."
        actions={
          permissionsSupported ? (
            <Badge variant={permissionsReady ? "success" : "warning"} dot>
              {permissionsReady ? "Ready" : "Permissions needed"}
            </Badge>
          ) : null
        }
      >
        {permissionsSupported && !permissionsReady ? (
          <div className="space-y-3 rounded-[var(--fd-radius-lg)] border border-warning/25 bg-warning-muted px-4 py-3">
            <p className="text-[length:var(--fd-text-sm)] text-fg-secondary">
              macOS needs to grant{" "}
              {nextPermission
                ? PERMISSION_LABELS[nextPermission]
                : "the remaining permissions"}{" "}
              before dictation can run.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={permissionBusy}
                onClick={() => void requestPermission()}
              >
                {permissionBusy ? <ActivityDiamond size="sm" /> : null}
                {nextPermission
                  ? `Allow ${PERMISSION_LABELS[nextPermission]}`
                  : "Check permissions"}
              </Button>
              {!permissions.accessibility ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    void import("@tauri-apps/api/core").then(({ invoke }) =>
                      invoke("open_dictation_accessibility_settings"),
                    )
                  }
                >
                  <ExternalLink aria-hidden="true" className="h-4 w-4" />
                  Open Accessibility settings
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <SettingList>
          <SwitchRow
            title="System-wide dictation"
            description="Hold or press your shortcut in any app. Escape cancels an active recording."
            checked={settings.enabled}
            onCheckedChange={setEnabled}
          />
          <SwitchRow
            title="Re-paste last transcript with ⌘⇧V"
            description="If a transcript missed the composer — say the cursor moved — press ⌘⇧V inside FalconDeck to insert it again."
            checked={settings.repasteShortcutEnabled}
            onCheckedChange={(repasteShortcutEnabled) =>
              updateSettings({ repasteShortcutEnabled })
            }
          />
        </SettingList>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Activation">
            <SegmentedControl
              ariaLabel="Activation"
              value={settings.activation}
              options={[
                { value: "hold", label: "Hold to dictate" },
                { value: "toggle", label: "Press to toggle" },
              ]}
              onChange={(activation) => updateSettings({ activation })}
            />
          </Field>
          <Field
            label="Shortcut key"
            htmlFor="dictation-shortcut"
            hint="Regular Command shortcuts keep working; dictation starts only when the key is held by itself."
          >
            <select
              id="dictation-shortcut"
              className={SELECT_CLASS}
              value={settings.shortcut}
              onChange={(event) =>
                updateSettings({
                  shortcut: event.target.value as DictationSettings["shortcut"],
                })
              }
            >
              <option value="right_command">Right Command</option>
              <option value="left_function">Left Function (fn)</option>
            </select>
          </Field>
        </div>

        <Field
          label="Microphone"
          htmlFor="dictation-microphone"
          hint="FalconDeck captures from this input only and never changes your audio output. A non-headset mic avoids Bluetooth headset mode while you dictate."
        >
          <select
            id="dictation-microphone"
            className={SELECT_CLASS}
            value={settings.inputDeviceId ?? ""}
            onChange={(event) =>
              updateSettings({ inputDeviceId: event.target.value || null })
            }
          >
            <option value="">
              System default
              {defaultAudioDeviceName ? ` (${defaultAudioDeviceName})` : ""}
            </option>
            {settings.inputDeviceId &&
            !audioDevices.some(
              (device) => device.id === settings.inputDeviceId,
            ) ? (
              <option value={settings.inputDeviceId}>
                Selected microphone unavailable — using system default
              </option>
            ) : null}
            {audioDevices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
          </select>
        </Field>
      </SettingsSection>

      <SettingsSection
        title="Transcription"
        description="Where recorded audio is turned into text. Apple Speech runs entirely on this Mac; OpenRouter sends audio from the daemon to a cloud model."
      >
        <Field label="Engine">
          <SegmentedControl
            ariaLabel="Transcription"
            value={settings.provider}
            options={[
              { value: "system", label: "Apple Speech" },
              { value: "open_router", label: "OpenRouter" },
            ]}
            onChange={(provider) => updateSettings({ provider })}
          />
        </Field>

        {settings.provider === "open_router" ? (
          <div className="space-y-5 border-t border-border-subtle pt-5">
            <Field label="Model" htmlFor="dictation-model">
              <select
                id="dictation-model"
                className={SELECT_CLASS}
                value={settings.model}
                onChange={(event) =>
                  updateSettings({ model: event.target.value })
                }
              >
                {!models.some((model) => model.id === settings.model) ? (
                  <option value={settings.model}>{settings.model}</option>
                ) : null}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label={
                <span className="flex items-center gap-2">
                  <KeyRound
                    aria-hidden="true"
                    className="h-3.5 w-3.5 text-fg-muted"
                  />
                  API key
                </span>
              }
              htmlFor={
                compact ? "onboarding-openrouter-key" : "openrouter-speech-key"
              }
              hint="Stored on this computer only. The daemon calls OpenRouter directly — paired devices never see the key."
            >
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  id={
                    compact
                      ? "onboarding-openrouter-key"
                      : "openrouter-speech-key"
                  }
                  className="max-w-md flex-1"
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={
                    configured ? "Replace key — sk-or-v1-…" : "sk-or-v1-…"
                  }
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button
                  onClick={() => void saveKey()}
                  disabled={credentialBusy || !apiKey.trim() || !baseUrl}
                >
                  {credentialBusy ? "Saving…" : "Save key"}
                </Button>
              </div>
              <div className="flex items-center gap-2 pt-0.5 text-[length:var(--fd-text-xs)]">
                {configured === null ? (
                  <span className="text-fg-muted">
                    Checking speech credentials…
                  </span>
                ) : configured ? (
                  <>
                    <ShieldCheck
                      aria-hidden="true"
                      className="h-3.5 w-3.5 text-success"
                    />
                    <span className="text-fg-secondary">
                      Key configured on this computer
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void removeKey()}
                      disabled={credentialBusy}
                    >
                      <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                      Remove
                    </Button>
                  </>
                ) : (
                  <span className="text-fg-muted">
                    No OpenRouter key configured
                  </span>
                )}
              </div>
            </Field>
          </div>
        ) : null}
      </SettingsSection>
    </div>
  );
}

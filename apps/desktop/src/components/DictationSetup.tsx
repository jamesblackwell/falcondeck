import { useCallback, useEffect, useState } from "react";

import { createDaemonApiClient } from "@falcondeck/client-core";
import {
  ActivityDiamond,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  cn,
} from "@falcondeck/ui";
import { ExternalLink, KeyRound, Mic, ShieldCheck, Trash2 } from "lucide-react";

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
  "fd-focus h-10 w-full rounded-[var(--fd-radius-md)] border border-border-default bg-surface-1 px-3 text-[length:var(--fd-text-sm)] text-fg-primary";

const PERMISSION_LABELS: Record<DictationPermission, string> = {
  microphone: "microphone access",
  speech_recognition: "Speech Recognition",
  accessibility: "Accessibility",
};

function PermissionBadge({
  label,
  granted,
}: {
  label: string;
  granted: boolean;
}) {
  return (
    <Badge variant={granted ? "success" : "warning"} dot>
      {label}: {granted ? "Ready" : "Needed"}
    </Badge>
  );
}

function ChoiceGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="space-y-2">
      <span className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
        {label}
      </span>
      <div
        className="grid grid-cols-2 rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-1 p-1"
        role="group"
        aria-label={label}
      >
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}
            className={cn(
              "fd-focus rounded-[var(--fd-radius-md)] px-3 py-2 text-[length:var(--fd-text-sm)] font-medium transition-colors",
              value === option.value
                ? "bg-surface-3 text-fg-primary shadow-sm"
                : "text-fg-muted hover:text-fg-primary",
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

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

  return (
    <div className={compact ? "space-y-4" : "space-y-6"}>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mic aria-hidden="true" className="h-4 w-4" />
            Desktop dictation
          </CardTitle>
          <CardDescription>
            Dictate into the app under your cursor while FalconDeck is running.
            Audio is deleted after a confirmed transcript is pasted.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <button
            type="button"
            aria-pressed={settings.enabled}
            onClick={() => setEnabled(!settings.enabled)}
            className={cn(
              "fd-focus flex w-full items-center justify-between gap-4 rounded-[var(--fd-radius-lg)] border px-4 py-3 text-left transition-colors",
              settings.enabled
                ? "border-accent/40 bg-accent-dim"
                : "border-border-subtle bg-surface-2 hover:bg-surface-3",
            )}
          >
            <span>
              <span className="block text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                Enable system-wide dictation
              </span>
              <span className="mt-1 block text-[length:var(--fd-text-sm)] text-fg-tertiary">
                Escape cancels an active recording.
              </span>
            </span>
            <Badge variant={settings.enabled ? "success" : "default"} dot>
              {settings.enabled ? "On" : "Off"}
            </Badge>
          </button>

          <div className="grid gap-4 sm:grid-cols-2">
            <ChoiceGroup
              label="Activation"
              value={settings.activation}
              options={[
                { value: "hold", label: "Hold to dictate" },
                { value: "toggle", label: "Press to toggle" },
              ]}
              onChange={(activation) => updateSettings({ activation })}
            />
            <div className="space-y-2">
              <label
                htmlFor="dictation-shortcut"
                className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary"
              >
                Shortcut key
              </label>
              <select
                id="dictation-shortcut"
                className={SELECT_CLASS}
                value={settings.shortcut}
                onChange={(event) =>
                  updateSettings({
                    shortcut: event.target
                      .value as DictationSettings["shortcut"],
                  })
                }
              >
                <option value="right_command">Right Command</option>
                <option value="left_function">Left Function (fn)</option>
              </select>
              <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
                Regular Command shortcuts continue to work; dictation starts
                only when the key is held by itself.
              </p>
            </div>
          </div>

          <button
            type="button"
            aria-pressed={settings.repasteShortcutEnabled}
            onClick={() =>
              updateSettings({
                repasteShortcutEnabled: !settings.repasteShortcutEnabled,
              })
            }
            className={cn(
              "fd-focus flex w-full items-center justify-between gap-4 rounded-[var(--fd-radius-lg)] border px-4 py-3 text-left transition-colors",
              settings.repasteShortcutEnabled
                ? "border-accent/40 bg-accent-dim"
                : "border-border-subtle bg-surface-2 hover:bg-surface-3",
            )}
          >
            <span>
              <span className="block text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                Re-paste last transcript with ⌘⇧V
              </span>
              <span className="mt-1 block text-[length:var(--fd-text-sm)] text-fg-tertiary">
                If a transcript missed the composer — say the cursor moved —
                press ⌘⇧V inside FalconDeck to insert it again.
              </span>
            </span>
            <Badge
              variant={settings.repasteShortcutEnabled ? "success" : "default"}
              dot
            >
              {settings.repasteShortcutEnabled ? "On" : "Off"}
            </Badge>
          </button>

          <div className="space-y-2">
            <label
              htmlFor="dictation-microphone"
              className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary"
            >
              Microphone
            </label>
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
            <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
              FalconDeck captures from this input only and does not change your
              audio output. Choosing a non-headset mic avoids Bluetooth headset
              mode while you dictate.
            </p>
          </div>

          <ChoiceGroup
            label="Transcription"
            value={settings.provider}
            options={[
              { value: "system", label: "Apple Speech" },
              { value: "open_router", label: "OpenRouter" },
            ]}
            onChange={(provider) => updateSettings({ provider })}
          />

          {settings.provider === "open_router" ? (
            <div className="space-y-2">
              <label
                htmlFor="dictation-model"
                className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary"
              >
                Transcription model
              </label>
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
            </div>
          ) : null}

          {isTauriDesktop() && permissions?.supported ? (
            <div className="space-y-3 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 p-3">
              <div className="flex flex-wrap gap-2">
                <PermissionBadge
                  label="Microphone"
                  granted={permissions.microphone === "granted"}
                />
                <PermissionBadge
                  label="Accessibility"
                  granted={permissions.accessibility}
                />
                {settings.provider === "system" ? (
                  <PermissionBadge
                    label="Speech Recognition"
                    granted={permissions.speechRecognition === "granted"}
                  />
                ) : null}
              </div>
              {!permissionsReady ? (
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
              ) : (
                <p className="flex items-center gap-2 text-[length:var(--fd-text-sm)] text-fg-secondary">
                  <ShieldCheck
                    aria-hidden="true"
                    className="h-4 w-4 text-success"
                  />
                  Ready to dictate
                </p>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound aria-hidden="true" className="h-4 w-4" />
            OpenRouter
          </CardTitle>
          <CardDescription>
            Optional cloud transcription. The daemon sends audio directly to
            OpenRouter and keeps the key on this computer.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 px-3 py-2 text-[length:var(--fd-text-sm)]">
            <ShieldCheck aria-hidden="true" className="h-4 w-4 text-success" />
            <span className="text-fg-secondary">
              {configured === null
                ? "Checking speech credentials…"
                : configured
                  ? "Configured on this computer"
                  : "No OpenRouter key configured"}
            </span>
          </div>
          <div className="space-y-2">
            <label
              htmlFor={
                compact ? "onboarding-openrouter-key" : "openrouter-speech-key"
              }
              className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary"
            >
              {configured ? "Replace API key" : "API key"}
            </label>
            <Input
              id={
                compact ? "onboarding-openrouter-key" : "openrouter-speech-key"
              }
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder="sk-or-v1-…"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="flex justify-end gap-2">
            {configured ? (
              <Button
                variant="ghost"
                onClick={() => void removeKey()}
                disabled={credentialBusy}
              >
                <Trash2 aria-hidden="true" className="h-4 w-4" />
                Remove
              </Button>
            ) : null}
            <Button
              onClick={() => void saveKey()}
              disabled={credentialBusy || !apiKey.trim() || !baseUrl}
            >
              {credentialBusy ? "Saving…" : "Save key"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";

import { createDaemonApiClient } from "@falcondeck/client-core";
import {
  ActivityDiamond,
  Badge,
  Button,
  CollapseRegion,
  Field,
  Input,
  SegmentedControl,
  SettingList,
  SettingsSection,
  SwitchRow,
  Textarea,
} from "@falcondeck/ui";
import {
  ChevronDown,
  ExternalLink,
  KeyRound,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import {
  DEFAULT_REWRITE_PROMPT,
  REWRITE_MODEL_CHOICES,
  nextRequiredDictationPermission,
  normalizeRewritePrompt,
  readDictationAudioDevices,
  readDictationPermissions,
  readDictationSettings,
  requestDictationPermission,
  useDictationSettings,
  writeDictationSettings,
  type DictationAudioDevice,
  type DictationPermission,
  type DictationPermissionStatus,
  type DictationSettings,
} from "../dictation";
import {
  REWRITE_SHORTCUT_SUGGESTIONS,
  isModifierOnlyDictationShortcut,
} from "../dictation-shortcut";
import { isTauriDesktop } from "../api";
import { DictationShortcutPicker } from "./DictationShortcutPicker";

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

const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";

type SpeechCredentialFieldProps = {
  baseUrl: string | null;
  onToast: (toast: DictationSetupToast) => void;
  id: string;
  hint: string;
  onConfiguredChange?: (configured: boolean | null) => void;
};

/**
 * Masked OpenRouter key field against the daemon speech secret. Shared by
 * Settings → Speech and the optional onboarding step so save/remove/status
 * stay one implementation.
 */
export function SpeechCredentialField({
  baseUrl,
  onToast,
  id,
  hint,
  onConfiguredChange,
}: SpeechCredentialFieldProps) {
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [credentialBusy, setCredentialBusy] = useState(false);

  const loadCredential = useCallback(async () => {
    if (!baseUrl) {
      setConfigured(null);
      onConfiguredChange?.(null);
      return;
    }
    try {
      const next = (
        await createDaemonApiClient(baseUrl).speechCredentialStatus()
      ).configured;
      setConfigured(next);
      onConfiguredChange?.(next);
    } catch {
      setConfigured(null);
      onConfiguredChange?.(null);
    }
  }, [baseUrl, onConfiguredChange]);

  useEffect(() => {
    void loadCredential();
  }, [loadCredential]);

  const saveKey = async () => {
    const cleaned = apiKey.trim();
    if (!baseUrl || !cleaned) return;
    setCredentialBusy(true);
    try {
      const status =
        await createDaemonApiClient(baseUrl).saveSpeechCredential(cleaned);
      setConfigured(status.configured);
      onConfiguredChange?.(status.configured);
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
      onConfiguredChange?.(false);
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

  return (
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
      htmlFor={id}
      hint={hint}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          className="max-w-md flex-1"
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          placeholder={configured ? "Replace key — sk-or-v1-…" : "sk-or-v1-…"}
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
      <div className="flex flex-wrap items-center gap-2 pt-0.5 text-[length:var(--fd-text-xs)]">
        {configured === null ? (
          <span className="text-fg-muted">
            {baseUrl
              ? "Checking speech credentials…"
              : "Connect to this computer to save a key."}
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
          <span className="text-fg-muted">No OpenRouter key configured</span>
        )}
        <a
          href={OPENROUTER_KEYS_URL}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 text-fg-secondary hover:text-fg-primary"
        >
          Get a key
          <ExternalLink aria-hidden="true" className="h-3 w-3" />
        </a>
      </div>
    </Field>
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
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [models, setModels] = useState<SpeechModel[]>([]);
  const [audioDevices, setAudioDevices] = useState<DictationAudioDevice[]>([]);
  const [rewritePromptOpen, setRewritePromptOpen] = useState(false);
  const [rewritePromptDraft, setRewritePromptDraft] = useState<string | null>(
    null,
  );

  const updateSettings = useCallback(
    (patch: Partial<DictationSettings>) =>
      writeDictationSettings({ ...settings, ...patch }),
    [settings],
  );

  const rewritePromptValue =
    rewritePromptDraft ?? settings.rewritePrompt ?? DEFAULT_REWRITE_PROMPT;
  const rewritePromptIsCustom =
    normalizeRewritePrompt(rewritePromptValue) != null;

  const persistRewritePrompt = useCallback((value: string | null) => {
    writeDictationSettings({
      ...readDictationSettings(),
      rewritePrompt: value,
    });
  }, []);

  const toggleRewritePrompt = () => {
    if (rewritePromptOpen) {
      if (rewritePromptDraft != null) persistRewritePrompt(rewritePromptDraft);
      setRewritePromptDraft(null);
      setRewritePromptOpen(false);
      return;
    }
    setRewritePromptDraft(settings.rewritePrompt ?? DEFAULT_REWRITE_PROMPT);
    setRewritePromptOpen(true);
  };

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
        description={
          compact
            ? "Off until you turn it on. Hold or press the shortcut in any app while FalconDeck is running."
            : settings.historyRetentionHours > 0
              ? "Dictate into the app under your cursor while FalconDeck is running. Recordings stay on this Mac for the window set under Recording history, then FalconDeck deletes them."
              : "Dictate into the app under your cursor while FalconDeck is running. Audio is deleted as soon as a transcript is pasted."
        }
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
              before dictation or voice rewrite can run.
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
          {compact ? null : (
            <SwitchRow
              title="Re-paste last transcript with ⌘⇧V"
              description="If a transcript missed the composer — say the cursor moved — press ⌘⇧V inside FalconDeck to insert it again."
              checked={settings.repasteShortcutEnabled}
              onCheckedChange={(repasteShortcutEnabled) =>
                updateSettings({ repasteShortcutEnabled })
              }
            />
          )}
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
            label="Shortcut"
            hint={
              isModifierOnlyDictationShortcut(settings.shortcut)
                ? "Regular Command shortcuts keep working; dictation starts only when the key is held by itself."
                : "FalconDeck uses this combination system-wide. A function key or a chord you do not type with is safest."
            }
          >
            <DictationShortcutPicker
              id={compact ? "onboarding-dictation-shortcut" : "dictation-shortcut"}
              label="Dictation shortcut"
              value={settings.shortcut}
              reserved={
                settings.rewriteEnabled ? [settings.rewriteShortcut] : []
              }
              reservedLabel="voice rewrite"
              onChange={(shortcut) => updateSettings({ shortcut })}
            />
          </Field>
        </div>

        {compact ? null : (
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
        )}
      </SettingsSection>

      {compact ? null : (
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
                label="Fallback model"
                htmlFor="dictation-fallback-model"
                hint="Tried when the first model fails or is rejected. Pick a different vendor so one provider's outage cannot take out both attempts."
              >
                <select
                  id="dictation-fallback-model"
                  className={SELECT_CLASS}
                  value={settings.fallbackModel ?? ""}
                  onChange={(event) =>
                    updateSettings({ fallbackModel: event.target.value || null })
                  }
                >
                  <option value="">
                    No second choice — use FalconDeck's chain
                  </option>
                  {settings.fallbackModel &&
                  !models.some((model) => model.id === settings.fallbackModel) ? (
                    <option value={settings.fallbackModel}>
                      {settings.fallbackModel}
                    </option>
                  ) : null}
                  {models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
          ) : null}

          {settings.provider === "open_router" || settings.rewriteEnabled ? (
            <div className="space-y-5 border-t border-border-subtle pt-5">
              <SpeechCredentialField
                baseUrl={baseUrl}
                onToast={onToast}
                id="openrouter-speech-key"
                hint={
                  settings.provider === "open_router"
                    ? "Stored on this computer only. The daemon calls OpenRouter directly — paired devices never see the key."
                    : "Rewrite sends selected text to OpenRouter with this key. Stored on this computer only."
                }
                onConfiguredChange={setConfigured}
              />
            </div>
          ) : null}
        </SettingsSection>
      )}

      <SettingsSection
        title="Voice rewrite"
        description={
          compact
            ? "Select text, hold a different shortcut, and speak how to edit it. Needs an OpenRouter key — optional on the next step."
            : "Select text in any app, hold a different shortcut, and speak how to edit it. FalconDeck transcribes the instruction, rewrites the selection through OpenRouter, and pastes over it."
        }
      >
        <SettingList>
          <SwitchRow
            title="Rewrite selected text"
            description={
              compact
                ? "Off until you turn it on. Uses Right Option by default."
                : "Off until you turn it on. Needs the same OpenRouter key as transcription, even when Apple Speech transcribes the instruction."
            }
            checked={settings.rewriteEnabled}
            onCheckedChange={(rewriteEnabled) =>
              updateSettings({ rewriteEnabled })
            }
          />
        </SettingList>
        <div className={compact ? undefined : "grid gap-5 sm:grid-cols-2"}>
          <Field
            label="Rewrite shortcut"
            hint="Must be a different shortcut from dictation."
          >
            <DictationShortcutPicker
              id={compact ? "onboarding-rewrite-shortcut" : "rewrite-shortcut"}
              label="Rewrite shortcut"
              value={settings.rewriteShortcut}
              suggested={REWRITE_SHORTCUT_SUGGESTIONS}
              reserved={settings.enabled ? [settings.shortcut] : []}
              reservedLabel="dictation"
              onChange={(rewriteShortcut) =>
                updateSettings({ rewriteShortcut })
              }
            />
          </Field>
          {compact ? null : (
            <Field
              label="Rewrite model"
              htmlFor="rewrite-model"
              hint="Luna is the default. GPT-OSS, Gemma, Mercury, and Gemini Flash Lite are cheaper or faster; you can also paste any OpenRouter model id."
            >
              <select
                className={SELECT_CLASS}
                value={
                  REWRITE_MODEL_CHOICES.some(
                    (model) => model.id === settings.rewriteModel,
                  )
                    ? settings.rewriteModel
                    : ""
                }
                onChange={(event) => {
                  if (!event.target.value) return;
                  updateSettings({ rewriteModel: event.target.value });
                }}
              >
                {!REWRITE_MODEL_CHOICES.some(
                  (model) => model.id === settings.rewriteModel,
                ) ? (
                  <option value="">Custom</option>
                ) : null}
                {REWRITE_MODEL_CHOICES.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
              <Input
                id="rewrite-model"
                className="mt-2 max-w-md"
                value={settings.rewriteModel}
                onChange={(event) =>
                  updateSettings({ rewriteModel: event.target.value })
                }
                placeholder="openai/gpt-5.6-luna"
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
          )}
        </div>
        {compact ? null : (
          <div className="space-y-2">
            <button
              type="button"
              className="fd-focus flex w-full items-center justify-between rounded-[var(--fd-radius-md)] px-0 py-1 text-left"
              aria-expanded={rewritePromptOpen}
              aria-controls="rewrite-prompt-editor"
              onClick={toggleRewritePrompt}
            >
              <span>
                <span className="block text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                  Custom prompt
                </span>
                <span className="mt-0.5 block text-[length:var(--fd-text-xs)] text-fg-muted">
                  {rewritePromptIsCustom
                    ? "Using a custom prompt"
                    : "Using the built-in prompt"}
                </span>
              </span>
              <ChevronDown
                aria-hidden="true"
                className={
                  rewritePromptOpen
                    ? "h-4 w-4 shrink-0 text-fg-muted rotate-180"
                    : "h-4 w-4 shrink-0 text-fg-muted"
                }
              />
            </button>
            <CollapseRegion open={rewritePromptOpen}>
              <div id="rewrite-prompt-editor" className="space-y-2 pb-1">
                <Textarea
                  aria-label="Rewrite prompt"
                  className="min-h-48 font-mono text-[length:var(--fd-text-xs)]"
                  value={rewritePromptValue}
                  onChange={(event) => {
                    const value = event.target.value;
                    setRewritePromptDraft(value);
                    persistRewritePrompt(value);
                  }}
                  spellCheck={false}
                />
                <div className="flex justify-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!rewritePromptIsCustom}
                    onClick={() => {
                      setRewritePromptDraft(DEFAULT_REWRITE_PROMPT);
                      persistRewritePrompt(null);
                    }}
                  >
                    <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                    Reset to built-in
                  </Button>
                </div>
              </div>
            </CollapseRegion>
          </div>
        )}
        {settings.rewriteEnabled &&
        settings.enabled &&
        settings.shortcut === settings.rewriteShortcut ? (
          <p className="text-[length:var(--fd-text-xs)] text-danger">
            Dictation already uses this key. Pick a different rewrite shortcut.
          </p>
        ) : null}
        {compact && settings.rewriteEnabled ? (
          <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
            Rewrite needs an OpenRouter key. Continue to add one, or skip and
            set it later in Settings → Speech.
          </p>
        ) : null}
        {!compact && settings.rewriteEnabled && configured === false ? (
          <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
            Save an OpenRouter key in Transcription above before rewrite can run.
          </p>
        ) : null}
      </SettingsSection>
    </div>
  );
}

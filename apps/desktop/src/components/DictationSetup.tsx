import { useCallback, useEffect, useRef, useState } from "react";

import { DictationDictionary } from "./DictationDictionary";

import { useParakeetStatus } from "../parakeet";

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
  SettingRow,
  SettingsSection,
  SwitchRow,
  Textarea,
  cn,
} from "@falcondeck/ui";
import {
  ChevronDown,
  ExternalLink,
  RotateCcw,
} from "lucide-react";

import {
  DEFAULT_REWRITE_MODEL,
  DEFAULT_REWRITE_PROMPT,
  REWRITE_MODEL_CHOICES,
  REWRITE_REASONING_EFFORTS,
  REWRITE_REASONING_LABELS,
  formatRewriteModelMeta,
  nextRequiredDictationPermission,
  normalizeRewritePrompt,
  parseRewriteCatalog,
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
  type RewriteCatalogModel,
  type RewriteReasoningEffort,
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
  /** Opens Settings → Models & keys, where the shared OpenRouter key lives. */
  onOpenModelsKeys?: () => void;
};

const SELECT_CLASS =
  "fd-focus h-9 w-full max-w-md rounded-[var(--fd-radius-md)] border border-border-default bg-surface-1 px-3 text-[length:var(--fd-text-sm)] text-fg-primary";

const PERMISSION_LABELS: Record<DictationPermission, string> = {
  microphone: "microphone access",
  speech_recognition: "Speech Recognition",
  accessibility: "Accessibility",
};

function modelChoiceClass(selected: boolean) {
  return cn(
    "fd-focus rounded-[var(--fd-radius-md)] border px-2.5 py-1.5 text-left text-[length:var(--fd-text-xs)] font-medium transition-colors",
    selected
      ? "border-accent/50 bg-accent/10 text-fg-primary"
      : "border-border-subtle bg-surface-2 text-fg-secondary hover:bg-surface-3",
  );
}

function effortFits(
  model: RewriteCatalogModel | undefined,
  effort: RewriteReasoningEffort | null,
): boolean {
  if (!model || effort == null) return true;
  if (model.reasoningMandatory && effort === "none") return false;
  return model.reasoningEfforts.includes(effort);
}

function ModelChoices({
  label,
  models,
  selectedId,
  onSelect,
}: {
  label: string;
  models: Array<{ id: string; name: string; meta: string | null }>;
  selectedId: string;
  onSelect: (id: string) => void;
}) {
  if (models.length === 0) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-[length:var(--fd-text-xs)] font-medium text-fg-muted">
        {label}
      </p>
      <div
        role="group"
        aria-label={`${label} models`}
        className="grid grid-cols-2 gap-2 xl:grid-cols-3"
      >
        {models.map((model) => {
          const selected = model.id === selectedId;
          return (
            <button
              key={model.id}
              type="button"
              aria-pressed={selected}
              title={model.id}
              onClick={() => onSelect(model.id)}
              className={modelChoiceClass(selected)}
            >
              <span className="block">{model.name}</span>
              {model.meta ? (
                <span
                  className="mt-0.5 block font-normal text-fg-muted"
                  aria-hidden="true"
                >
                  {model.meta}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RewriteModelFields({
  baseUrl,
  settings,
  onChange,
}: {
  baseUrl: string | null;
  settings: DictationSettings;
  onChange: (patch: Partial<DictationSettings>) => void;
}) {
  const [catalog, setCatalog] = useState<RewriteCatalogModel[] | null>(null);
  const [stale, setStale] = useState(false);
  const [catalogState, setCatalogState] = useState<
    "loading" | "ready" | "offline"
  >(baseUrl ? "loading" : "offline");
  const catalogRef = useRef<RewriteCatalogModel[] | null>(null);

  useEffect(() => {
    if (!baseUrl) {
      catalogRef.current = null;
      setCatalog(null);
      setStale(false);
      setCatalogState("offline");
      return;
    }
    let cancelled = false;
    if (!catalogRef.current) setCatalogState("loading");
    const keepCurrent = () => {
      if (catalogRef.current) {
        setStale(true);
        setCatalogState("ready");
      } else {
        setCatalogState("offline");
      }
    };
    void fetch(`${baseUrl}/api/speech/rewrite-models`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Model list failed");
        return parseRewriteCatalog(await response.json());
      })
      .then((parsed) => {
        if (cancelled) return;
        if (!parsed) {
          keepCurrent();
          return;
        }
        catalogRef.current = parsed.models;
        setCatalog(parsed.models);
        setStale(parsed.stale);
        setCatalogState("ready");
      })
      .catch(() => {
        if (!cancelled) keepCurrent();
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);

  const modelId = settings.rewriteModel.trim();
  const known = catalog?.find((model) => model.id === modelId);
  const efforts: RewriteReasoningEffort[] = known
    ? known.reasoningEfforts.filter(
        (effort) => !(known.reasoningMandatory && effort === "none"),
      )
    : [...REWRITE_REASONING_EFFORTS];
  const selectedEffort =
    settings.rewriteReasoning && efforts.includes(settings.rewriteReasoning)
      ? settings.rewriteReasoning
      : "auto";

  useEffect(() => {
    if (!known || effortFits(known, settings.rewriteReasoning)) return;
    onChange({ rewriteReasoning: null });
  }, [known, settings.rewriteReasoning, onChange]);

  const selectModel = (id: string) => {
    const next = catalog?.find((model) => model.id === id);
    onChange({
      rewriteModel: id,
      ...(effortFits(next, settings.rewriteReasoning)
        ? {}
        : { rewriteReasoning: null }),
    });
  };

  const fast =
    catalog
      ?.filter((model) => model.group === "fast")
      .map((model) => ({
        id: model.id,
        name: model.name,
        meta: formatRewriteModelMeta(model),
      })) ?? [];
  const frontier =
    catalog
      ?.filter((model) => model.group === "frontier")
      .map((model) => ({
        id: model.id,
        name: model.name,
        meta: formatRewriteModelMeta(model),
      })) ?? [];
  const suggested = REWRITE_MODEL_CHOICES.map((model) => ({
    id: model.id,
    name: model.name,
    meta: null,
  }));

  const hint =
    catalogState === "loading"
      ? "Loading the current OpenRouter list."
      : catalogState === "ready"
        ? stale
          ? "Saved list from this computer. OpenRouter could not be reached just now."
          : "Fast models are cheap enough for every paste. Frontier models lead the intelligence index. Figures are that index, then dollars per million tokens, in and out."
        : "OpenRouter's list is unavailable. These suggestions stay on this computer, or paste any model id.";

  return (
    <div className="space-y-4">
      <Field label="Rewrite model" htmlFor="rewrite-model" hint={hint}>
        {catalogState === "loading" ? (
          <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
            Loading models from OpenRouter…
          </p>
        ) : catalogState === "ready" ? (
          <div className="space-y-3">
            <ModelChoices
              label="Fast"
              models={fast}
              selectedId={modelId}
              onSelect={selectModel}
            />
            <ModelChoices
              label="Frontier"
              models={frontier}
              selectedId={modelId}
              onSelect={selectModel}
            />
          </div>
        ) : (
          <ModelChoices
            label="Suggested"
            models={suggested}
            selectedId={modelId}
            onSelect={selectModel}
          />
        )}
        <Input
          id="rewrite-model"
          className="mt-2 max-w-md"
          value={settings.rewriteModel}
          aria-label="Rewrite model id"
          onChange={(event) => {
            const rewriteModel = event.target.value;
            const next = catalog?.find(
              (model) => model.id === rewriteModel.trim(),
            );
            onChange({
              rewriteModel,
              ...(effortFits(next, settings.rewriteReasoning)
                ? {}
                : { rewriteReasoning: null }),
            });
          }}
          placeholder={DEFAULT_REWRITE_MODEL}
          spellCheck={false}
          autoComplete="off"
        />
        {catalogState === "ready" && modelId && !known ? (
          <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
            Not in the current shortlist. FalconDeck still sends this id.
          </p>
        ) : null}
      </Field>
      <Field
        label="Reasoning"
        hint="Auto uses the fastest effort the model allows. Raise it when an edit needs more thought."
      >
        <div
          role="group"
          aria-label="Reasoning effort"
          className="flex flex-wrap gap-1.5"
        >
          <button
            type="button"
            aria-pressed={selectedEffort === "auto"}
            onClick={() => onChange({ rewriteReasoning: null })}
            className={modelChoiceClass(selectedEffort === "auto")}
          >
            Auto
          </button>
          {efforts.map((effort) => (
            <button
              key={effort}
              type="button"
              aria-pressed={selectedEffort === effort}
              onClick={() => onChange({ rewriteReasoning: effort })}
              className={modelChoiceClass(selectedEffort === effort)}
            >
              {REWRITE_REASONING_LABELS[effort]}
            </button>
          ))}
        </div>
      </Field>
    </div>
  );
}

/** Read-only OpenRouter key status for pages that link to where it is set. */
function useOpenRouterKeyConfigured(baseUrl: string | null) {
  const [configured, setConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    if (!baseUrl) {
      setConfigured(null);
      return;
    }
    let cancelled = false;
    createDaemonApiClient(baseUrl)
      .speechCredentialStatus()
      .then((status) => {
        if (!cancelled) setConfigured(status.configured);
      })
      .catch(() => {
        if (!cancelled) setConfigured(null);
      });
    return () => {
      cancelled = true;
    };
  }, [baseUrl]);
  return configured;
}

export function DictationSetup({
  baseUrl,
  onToast,
  compact = false,
  onOpenModelsKeys,
}: DictationSetupProps) {
  const settings = useDictationSettings();
  const [permissions, setPermissions] =
    useState<DictationPermissionStatus | null>(null);
  const [permissionBusy, setPermissionBusy] = useState(false);
  const configured = useOpenRouterKeyConfigured(compact ? null : baseUrl);
  const [models, setModels] = useState<SpeechModel[]>([]);
  const [audioDevices, setAudioDevices] = useState<DictationAudioDevice[]>([]);
  const [rewritePromptOpen, setRewritePromptOpen] = useState(false);
  const [rewritePromptDraft, setRewritePromptDraft] = useState<string | null>(
    null,
  );

  const parakeet = useParakeetStatus();

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
    if (enabled && settings.provider === "parakeet" && !parakeet.status?.installed) void parakeet.prepare();
  };

  const permissionsReady =
    permissions?.microphone === "granted" &&
    permissions.accessibility &&
    (settings.provider !== "parakeet" || (parakeet.status?.supported && parakeet.status.installed)) &&
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
          description="Apple Speech and Parakeet transcribe on this Mac. OpenRouter sends recorded audio to a cloud model."
        >
          <Field label="Engine">
            <SegmentedControl
              ariaLabel="Transcription"
              value={settings.provider}
              options={[
                { value: "system", label: "Apple Speech" },
                { value: "parakeet", label: "Parakeet" },
                { value: "open_router", label: "OpenRouter" },
              ]}
              onChange={(provider) => {
                updateSettings({ provider });
                if (provider === "parakeet" && parakeet.status?.supported !== false && !parakeet.preparing && !parakeet.status?.busy) {
                  void parakeet.prepare();
                }
              }}
            />
          </Field>

          {settings.provider === "parakeet" ? (
            <div className="space-y-4 border-t border-border-subtle pt-5">
              <p className="text-sm text-fg-secondary">
                Parakeet v3 uses this Mac’s Neural Engine. Download the model once;
                recordings stay on this Mac. Optional cleanup and rewrite still use OpenRouter.
              </p>
              {parakeet.status?.supported === false ? (
                <p role="alert" className="text-sm text-fg-secondary">Requires Apple Silicon and macOS 14 or later.</p>
              ) : parakeet.preparing || parakeet.status?.busy ? (
                <p role="status" className="text-sm text-fg-secondary">
                  {parakeet.status?.phase || "Preparing Parakeet"}…
                  {parakeet.status?.progress != null ? ` ${Math.round(parakeet.status.progress * 100)}%` : ""}
                </p>
              ) : parakeet.status?.installed ? (
                <p role="status" className="text-sm text-fg-secondary">
                  {parakeet.status.loaded ? "Ready — model loaded" : "Downloaded — loads when recording starts"}
                </p>
              ) : (
                <Button variant="secondary" onClick={() => void parakeet.prepare()}>Download Parakeet</Button>
              )}
              {parakeet.error ? (
                <div className="space-y-2">
                  <p role="alert" className="text-sm text-fg-secondary">{parakeet.error}</p>
                  <Button variant="secondary" disabled={parakeet.preparing || parakeet.status?.busy || parakeet.status?.supported === false} onClick={() => void parakeet.prepare()}>Retry setup</Button>
                </div>
              ) : null}
              <details>
                <summary className="cursor-pointer text-sm text-fg-secondary">Advanced options</summary>
                <div className="pt-4">
                  <Field label="Keep model loaded" htmlFor="parakeet-idle-minutes" hint="Keeps repeat dictations fast. The model unloads after this long without use; disabling dictation or changing engines unloads it too.">
                    <select id="parakeet-idle-minutes" className={SELECT_CLASS} value={settings.parakeetIdleMinutes} onChange={(event) => updateSettings({ parakeetIdleMinutes: Number(event.target.value) })}>
                      {![0, 5, 10, 15, 30, 60].includes(settings.parakeetIdleMinutes) ? <option value={settings.parakeetIdleMinutes}>{settings.parakeetIdleMinutes} minutes</option> : null}
                      <option value={0}>Unload after each dictation</option>
                      {[5, 10, 15, 30, 60].map((minutes) => <option key={minutes} value={minutes}>{minutes} minutes{minutes === 15 ? " (default)" : ""}</option>)}
                    </select>
                  </Field>
                  {parakeet.status?.supported ? (
                    <div className="mt-4 space-y-2">
                      <Button variant="secondary" disabled={parakeet.preparing || parakeet.status.busy} onClick={() => void parakeet.prepare(true)}>
                        Re-download model
                      </Button>
                      <p className="text-sm text-fg-secondary">Downloads a fresh copy if the installed model cannot load.</p>
                    </div>
                  ) : null}
                </div>
              </details>
            </div>
          ) : null}

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

          <SettingList>
            <SwitchRow
              title="Automatically clean up transcriptions"
              description="Uses the rewrite model below to fix obvious transcription errors, numbers, and names such as FalconDeck and QuizGecko, with natural punctuation and paragraph breaks before pasting. Needs an OpenRouter key, including with Apple Speech. If cleanup fails, the original transcript is pasted."
              checked={settings.autoCleanupEnabled}
              onCheckedChange={(autoCleanupEnabled) =>
                updateSettings({ autoCleanupEnabled })
              }
            />
            <SettingRow
              title="OpenRouter key"
              description={
                configured
                  ? "Set. Used for OpenRouter transcription, cleanup, and voice rewrite."
                  : configured === false
                    ? "Not set. OpenRouter transcription, cleanup, and voice rewrite need one."
                    : "Needed for OpenRouter transcription, cleanup, and voice rewrite."
              }
              control={
                onOpenModelsKeys ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={onOpenModelsKeys}
                  >
                    {configured ? "Manage key" : "Add key"}
                  </Button>
                ) : null
              }
            />
          </SettingList>
        </SettingsSection>
      )}

      {compact ? null : <DictationDictionary />}

      <SettingsSection
        title="Voice rewrite"
        description={
          compact
            ? "Select text and hold a different shortcut. Speak how to edit it, or say nothing to tidy it. Needs an OpenRouter key — you can add one later in setup."
            : "Select text in any app and hold a different shortcut. Speak how to edit it, or say nothing to tidy it. FalconDeck rewrites the selection through OpenRouter and pastes over it."
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
        <div className={compact ? undefined : "max-w-xl"}>
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
        </div>
        {compact ? null : (
          <RewriteModelFields
            baseUrl={baseUrl}
            settings={settings}
            onChange={updateSettings}
          />
        )}
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
            set it later in Settings → Models & keys.
          </p>
        ) : null}
        {!compact && settings.rewriteEnabled && configured === false ? (
          <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
            Add an OpenRouter key in Models & keys before rewrite can run.
          </p>
        ) : null}
      </SettingsSection>
    </div>
  );
}

import { useEffect, useState } from "react";

import { isTauriDesktop } from "./api";

const DICTATION_STORAGE_KEY = "falcondeck.desktop.dictation.v2";
const LEGACY_DICTATION_STORAGE_KEY = "falcondeck.desktop.dictation.v1";
const DICTATION_SETTINGS_EVENT = "falcondeck:dictation-settings-changed";
const DEFAULT_TRANSCRIPTION_MODEL = "openai/gpt-4o-mini-transcribe";
// Models that were shipped as the default at some point. Found under the v1
// storage key they represent our old choice, not the user's, so the one-time
// v2 migration upgrades them; picked explicitly in v2 they stick.
const SUPERSEDED_DEFAULT_MODELS = [
  "openai/whisper-large-v3-turbo",
  "openai/gpt-transcribe",
];
// Deliberately a different vendor from the default model: a fallback only
// earns its keep when an OpenAI outage cannot take out both attempts. Voxtral
// Mini transcribes long-form audio and costs about the same per minute.
const DEFAULT_FALLBACK_MODEL = "mistralai/voxtral-mini-transcribe";
// Recordings are kept only long enough to retry a bad transcript.
const DEFAULT_HISTORY_RETENTION_HOURS = 6;
export const DICTATION_RETENTION_CHOICES = [0, 1, 6, 24] as const;

export type DictationShortcut = "right_command" | "left_function";
export type DictationActivation = "hold" | "toggle";
export type DictationProvider = "system" | "open_router";
export type DictationPermission =
  "microphone" | "speech_recognition" | "accessibility";

export type DictationSettings = {
  enabled: boolean;
  shortcut: DictationShortcut;
  activation: DictationActivation;
  provider: DictationProvider;
  inputDeviceId: string | null;
  model: string;
  // Cmd+Shift+V inside FalconDeck re-inserts the last transcript, for when a
  // paste landed nowhere because the caret had moved.
  repasteShortcutEnabled: boolean;
  // Tried right after `model` when the preferred model fails or is rejected.
  // Null falls straight through to FalconDeck's built-in chain.
  fallbackModel: string | null;
  // How long recordings stay on this computer so a failed or wrong transcript
  // can be retried with another model. Zero deletes them immediately.
  historyRetentionHours: number;
};

export type DictationHistoryEntry = {
  id: string;
  path: string;
  recordedAtMs: number;
  durationSeconds: number;
  bytes: number;
  provider: DictationProvider;
  model: string | null;
  text: string | null;
  error: string | null;
  audioAvailable: boolean;
};

export type DictationAudioDevice = {
  id: string;
  name: string;
  isDefault: boolean;
};

export type DictationPermissionStatus = {
  microphone: "not_requested" | "denied" | "granted" | "unsupported";
  speechRecognition: "not_requested" | "denied" | "granted" | "unsupported";
  accessibility: boolean;
  supported: boolean;
};

export function nextRequiredDictationPermission(
  status: DictationPermissionStatus,
  provider: DictationProvider,
): DictationPermission | null {
  if (status.microphone !== "granted") return "microphone";
  if (provider === "system" && status.speechRecognition !== "granted") {
    return "speech_recognition";
  }
  if (!status.accessibility) return "accessibility";
  return null;
}

export const DEFAULT_DICTATION_SETTINGS: DictationSettings = {
  enabled: false,
  shortcut: "right_command",
  activation: "hold",
  provider: "system",
  inputDeviceId: null,
  model: DEFAULT_TRANSCRIPTION_MODEL,
  repasteShortcutEnabled: true,
  fallbackModel: DEFAULT_FALLBACK_MODEL,
  historyRetentionHours: DEFAULT_HISTORY_RETENTION_HOURS,
};

function isDictationShortcut(value: unknown): value is DictationShortcut {
  return value === "right_command" || value === "left_function";
}

function isDictationActivation(value: unknown): value is DictationActivation {
  return value === "hold" || value === "toggle";
}

function isDictationProvider(value: unknown): value is DictationProvider {
  return value === "system" || value === "open_router";
}

function normalizeRetentionHours(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return DEFAULT_DICTATION_SETTINGS.historyRetentionHours;
  }
  // Anything outside the offered choices is clamped rather than rejected, so a
  // hand-edited value still bounds how long audio lingers.
  return Math.min(Math.round(value), 24);
}

export function normalizeDictationSettings(value: unknown): DictationSettings {
  if (!value || typeof value !== "object") return DEFAULT_DICTATION_SETTINGS;
  const candidate = value as Partial<DictationSettings>;
  return {
    enabled:
      typeof candidate.enabled === "boolean"
        ? candidate.enabled
        : DEFAULT_DICTATION_SETTINGS.enabled,
    shortcut: isDictationShortcut(candidate.shortcut)
      ? candidate.shortcut
      : DEFAULT_DICTATION_SETTINGS.shortcut,
    activation: isDictationActivation(candidate.activation)
      ? candidate.activation
      : DEFAULT_DICTATION_SETTINGS.activation,
    provider: isDictationProvider(candidate.provider)
      ? candidate.provider
      : DEFAULT_DICTATION_SETTINGS.provider,
    inputDeviceId:
      typeof candidate.inputDeviceId === "string" && candidate.inputDeviceId
        ? candidate.inputDeviceId
        : null,
    model:
      typeof candidate.model === "string" && candidate.model.trim()
        ? candidate.model.trim()
        : DEFAULT_DICTATION_SETTINGS.model,
    repasteShortcutEnabled:
      typeof candidate.repasteShortcutEnabled === "boolean"
        ? candidate.repasteShortcutEnabled
        : DEFAULT_DICTATION_SETTINGS.repasteShortcutEnabled,
    fallbackModel:
      candidate.fallbackModel === null
        ? null
        : typeof candidate.fallbackModel === "string" &&
            candidate.fallbackModel.trim()
          ? candidate.fallbackModel.trim()
          : DEFAULT_DICTATION_SETTINGS.fallbackModel,
    historyRetentionHours: normalizeRetentionHours(
      candidate.historyRetentionHours,
    ),
  };
}

export function readDictationSettings(): DictationSettings {
  if (typeof window === "undefined") return DEFAULT_DICTATION_SETTINGS;
  try {
    const raw = window.localStorage.getItem(DICTATION_STORAGE_KEY);
    if (raw) return normalizeDictationSettings(JSON.parse(raw) as unknown);
    const legacyRaw = window.localStorage.getItem(LEGACY_DICTATION_STORAGE_KEY);
    if (!legacyRaw) return DEFAULT_DICTATION_SETTINGS;
    const migrated = normalizeDictationSettings(
      JSON.parse(legacyRaw) as unknown,
    );
    return SUPERSEDED_DEFAULT_MODELS.includes(migrated.model)
      ? { ...migrated, model: DEFAULT_TRANSCRIPTION_MODEL }
      : migrated;
  } catch {
    return DEFAULT_DICTATION_SETTINGS;
  }
}

export function writeDictationSettings(settings: DictationSettings): void {
  if (typeof window === "undefined") return;
  const normalized = normalizeDictationSettings(settings);
  try {
    window.localStorage.setItem(
      DICTATION_STORAGE_KEY,
      JSON.stringify(normalized),
    );
  } catch {
    // The current session still receives the update below if storage is full
    // or unavailable; only persistence across launch is lost.
  }
  window.dispatchEvent(
    new CustomEvent<DictationSettings>(DICTATION_SETTINGS_EVENT, {
      detail: normalized,
    }),
  );
}

export function useDictationSettings(): DictationSettings {
  const [settings, setSettings] = useState(readDictationSettings);

  useEffect(() => {
    const update = (event: Event) => {
      if (event instanceof CustomEvent && event.detail) {
        setSettings(normalizeDictationSettings(event.detail));
      } else {
        setSettings(readDictationSettings());
      }
    };
    window.addEventListener(DICTATION_SETTINGS_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.removeEventListener(DICTATION_SETTINGS_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);

  return settings;
}

export function useDesktopDictation(baseUrl: string | null): void {
  const settings = useDictationSettings();

  useEffect(() => {
    if (!isTauriDesktop()) return;
    let cancelled = false;
    void import("@tauri-apps/api/core").then(({ invoke }) => {
      if (cancelled) return;
      const providerReady = settings.provider === "system" || Boolean(baseUrl);
      return invoke("configure_dictation", {
        config: {
          ...settings,
          enabled: settings.enabled && providerReady,
          daemonUrl: baseUrl,
        },
      }).catch(() => {
        // Native support is optional outside macOS builds. Settings remain
        // persisted and will be applied when the supported desktop is ready.
      });
    });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, settings]);
}

export async function readDictationPermissions(): Promise<DictationPermissionStatus> {
  if (!isTauriDesktop()) {
    return {
      microphone: "unsupported",
      speechRecognition: "unsupported",
      accessibility: false,
      supported: false,
    };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DictationPermissionStatus>("dictation_permission_status");
}

export async function readDictationAudioDevices(): Promise<
  DictationAudioDevice[]
> {
  if (!isTauriDesktop()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DictationAudioDevice[]>("dictation_audio_devices");
}

export async function requestDictationPermission(
  permission: DictationPermission,
): Promise<void> {
  if (!isTauriDesktop()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("request_dictation_permission", { permission });
}

export async function readDictationHistory(): Promise<DictationHistoryEntry[]> {
  if (!isTauriDesktop()) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DictationHistoryEntry[]>("dictation_history");
}

// Transcribes a kept recording again, optionally with a different model.
export async function retryDictationHistoryEntry(
  id: string,
  model?: string,
): Promise<DictationHistoryEntry> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<DictationHistoryEntry>("dictation_history_retry", {
    id,
    model: model ?? null,
  });
}

export async function deleteDictationHistoryEntry(id: string): Promise<void> {
  if (!isTauriDesktop()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("dictation_history_delete", { id });
}

export async function clearDictationHistory(): Promise<void> {
  if (!isTauriDesktop()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("dictation_history_clear");
}

import { useCallback, useEffect, useState } from "react";

import {
  ActivityDiamond,
  Badge,
  Button,
  EmptyState,
  Field,
  SettingsSection,
} from "@falcondeck/ui";
import { History, RotateCcw, Trash2 } from "lucide-react";

import {
  DICTATION_RETENTION_CHOICES,
  clearDictationHistory,
  deleteDictationHistoryEntry,
  readDictationHistory,
  retryDictationHistoryEntry,
  useDictationSettings,
  writeDictationSettings,
  type DictationHistoryEntry,
} from "../dictation";
import { isTauriDesktop } from "../api";
import { useParakeetStatus } from "../parakeet";
import {
  LOCAL_PARAKEET_RETRY,
  formatRecordedAt,
  formatRecordingLength,
  retentionSummary,
  transcriptionEngineLabel,
} from "./dictation-history-utils";
import type { DictationSetupToast } from "./DictationSetup";

type SpeechModel = { id: string; name: string };

type DictationHistoryCardProps = {
  baseUrl: string | null;
  onToast: (toast: DictationSetupToast) => void;
};

const SELECT_CLASS =
  "fd-focus h-9 w-full max-w-md rounded-[var(--fd-radius-md)] border border-border-default bg-surface-1 px-3 text-[length:var(--fd-text-sm)] text-fg-primary";

const RETENTION_LABELS: Record<number, string> = {
  0: "Don't keep recordings",
  1: "1 hour",
  6: "6 hours",
  24: "24 hours",
};

export function DictationHistoryCard({
  baseUrl,
  onToast,
}: DictationHistoryCardProps) {
  const settings = useDictationSettings();
  const [entries, setEntries] = useState<DictationHistoryEntry[]>([]);
  const [models, setModels] = useState<SpeechModel[]>([]);
  const [retryModel, setRetryModel] = useState("");
  const { status: parakeetStatus } = useParakeetStatus();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    const updateNow = () => setNow(Date.now());
    updateNow();
    const timer = window.setInterval(updateNow, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setEntries(await readDictationHistory());
    } catch {
      setEntries([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, settings.historyRetentionHours]);

  // Native filing runs off the UI thread. Refresh after its index write,
  // rather than racing a terminal overlay event against that detached write.
  useEffect(() => {
    if (!isTauriDesktop()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen("falcondeck://dictation-history-changed", () => {
        void refresh();
      }).then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      }),
    );
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [refresh]);

  useEffect(() => {
    if (!baseUrl) return;
    void fetch(`${baseUrl}/api/speech/models`)
      .then(async (response) => {
        if (!response.ok) throw new Error("Model discovery failed");
        return response.json() as Promise<SpeechModel[]>;
      })
      .then(setModels)
      .catch(() => setModels([]));
  }, [baseUrl]);

  const localParakeetInstalled = Boolean(parakeetStatus?.installed);
  const retryLocally = retryModel === LOCAL_PARAKEET_RETRY;

  const defaultRetryIsLocal = (entry: DictationHistoryEntry) =>
    entry.provider === "parakeet" || settings.provider === "parakeet";

  const retry = async (entry: DictationHistoryEntry, tryAnyway = false) => {
    setBusyId(entry.id);
    try {
      const updated = tryAnyway
        ? await retryDictationHistoryEntry(entry.id, undefined, "parakeet", true)
        : retryLocally || (settings.provider === "parakeet" && !retryModel)
          ? await retryDictationHistoryEntry(entry.id, undefined, "parakeet")
          : await retryDictationHistoryEntry(entry.id, retryModel || (defaultRetryIsLocal(entry) ? undefined : settings.model));
      setEntries((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      if (updated.text !== null && !updated.text.trim()) {
        onToast({ variant: "success", title: "Words removed", description: "The correction dictionary left nothing to paste." });
        return;
      }
      try {
        if (!updated.text) throw new Error("No transcript was returned.");
        await navigator.clipboard.writeText(updated.text);
        onToast({ variant: "success", title: "Transcript copied", description: "Ready to paste wherever you need it." });
      } catch {
        onToast({ variant: "warning", title: "Transcript ready", description: "Clipboard copy failed. Use Copy transcript below to try again." });
      }
    } catch (error) {
      onToast({
        variant: "danger",
        title: "Could not transcribe that recording",
        description: error instanceof Error ? error.message : String(error),
      });
      void refresh();
    } finally {
      setBusyId(null);
    }
  };

  const copy = async (entry: DictationHistoryEntry) => {
    if (!entry.text) return;
    try {
      await navigator.clipboard.writeText(entry.text);
      onToast({ variant: "success", title: "Transcript copied" });
    } catch (error) {
      onToast({
        variant: "danger",
        title: "Could not copy the transcript",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const remove = async (entry: DictationHistoryEntry) => {
    try {
      await deleteDictationHistoryEntry(entry.id);
      setEntries((current) => current.filter((item) => item.id !== entry.id));
    } catch (error) {
      onToast({
        variant: "danger",
        title: "Could not delete the recording",
        description: error instanceof Error ? error.message : String(error),
      });
      void refresh();
    }
  };

  const clearAll = async () => {
    try {
      await clearDictationHistory();
      setEntries([]);
      onToast({ variant: "success", title: "Recordings deleted" });
    } catch (error) {
      onToast({
        variant: "danger",
        title: "Could not delete the recordings",
        description: error instanceof Error ? error.message : String(error),
      });
      void refresh();
    }
  };

  if (!isTauriDesktop()) return null;

  const retentionEnabled = settings.historyRetentionHours > 0;

  return (
    <SettingsSection
      title="Recording history"
      description={retentionSummary(settings.historyRetentionHours)}
      actions={
        entries.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={() => void clearAll()}>
            <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
            Delete all
          </Button>
        ) : null
      }
    >
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Keep recordings for" htmlFor="dictation-retention">
          <select
            id="dictation-retention"
            className={SELECT_CLASS}
            value={settings.historyRetentionHours}
            onChange={(event) =>
              writeDictationSettings({
                ...settings,
                historyRetentionHours: Number(event.target.value),
              })
            }
          >
            {DICTATION_RETENTION_CHOICES.map((hours) => (
              <option key={hours} value={hours}>
                {RETENTION_LABELS[hours]}
              </option>
            ))}
          </select>
        </Field>
        {retentionEnabled ? (
          <Field
            label="Retry using"
            htmlFor="dictation-retry-model"
            hint="Parakeet on this Mac keeps the audio local, but transcript cleanup still sends the text to OpenRouter. OpenRouter models, including OpenRouter's Parakeet, send the audio to the cloud and never fall back to another model."
          >
            <select
              id="dictation-retry-model"
              className={SELECT_CLASS}
              value={retryModel}
              onChange={(event) => setRetryModel(event.target.value)}
            >
              <option value="">{settings.provider === "parakeet" ? "Default retry (stays local)" : "Default retry (Parakeet recordings stay local)"}</option>
              {/* Stays listed if the model is removed while selected: quietly
                  dropping the choice would send audio to the cloud instead. */}
              {localParakeetInstalled || retryLocally ? (
                <option value={LOCAL_PARAKEET_RETRY}>
                  {localParakeetInstalled ? "Parakeet on this Mac (local)" : "Parakeet on this Mac (not downloaded)"}
                </option>
              ) : null}
              <optgroup label="OpenRouter (cloud)">
                {retryModel && !retryLocally && !models.some((model) => model.id === retryModel) ? (
                  <option value={retryModel}>{retryModel}</option>
                ) : null}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </Field>
        ) : null}
      </div>

      {retentionEnabled ? (
        entries.length === 0 ? (
          <EmptyState
            icon={<History aria-hidden="true" className="h-5 w-5" />}
            title="No recordings kept yet"
            description="Dictate something and it will wait here in case the transcript comes back wrong."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {entries.map((entry) => {
              const failed = Boolean(entry.error);
              const corrupted = entry.captureCorrupted;
              const retriesLocally = retryLocally || (defaultRetryIsLocal(entry) && !retryModel);
              const retryBlocked = retryLocally && !localParakeetInstalled;
              // A failed retry keeps the text it could not replace. It belongs
              // to an earlier attempt and must not read as this one's result.
              const earlierAttempt = failed && Boolean(entry.text?.trim()) ? entry.text : null;
              return (
              <li
                key={entry.id}
                className="rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 px-3.5 py-3"
              >
                <div className="flex flex-wrap items-center gap-2 text-[length:var(--fd-text-xs)] text-fg-muted">
                  <span className="text-fg-secondary">
                    {formatRecordedAt(entry.recordedAtMs, now)}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{formatRecordingLength(entry.durationSeconds)}</span>
                  <Badge variant="default">{transcriptionEngineLabel(entry)}</Badge>
                  {corrupted ? (
                    <Badge variant="danger" dot>
                      Recording corrupted
                    </Badge>
                  ) : failed ? (
                    <Badge variant="danger" dot>
                      Failed
                    </Badge>
                  ) : null}
                  {entry.rawCaptureAvailable && !corrupted ? (
                    <Badge variant="default">Recovered capture</Badge>
                  ) : null}
                  {!entry.audioAvailable ? (
                    <Badge variant="warning">Audio deleted</Badge>
                  ) : null}
                </div>
                {failed ? (
                  <p className="mt-1.5 text-[length:var(--fd-text-sm)] text-danger">
                    {earlierAttempt && !corrupted ? `This retry failed: ${entry.error}` : entry.error}
                  </p>
                ) : (
                  <p className="mt-1.5 line-clamp-3 text-[length:var(--fd-text-sm)] text-fg-primary">
                    {entry.text !== null && !entry.text.trim() ? "Words removed by dictionary" : entry.text ?? "No transcript"}
                  </p>
                )}
                {corrupted ? (
                  <p className="mt-1 text-[length:var(--fd-text-xs)] text-fg-muted">
                    This probably can't be transcribed, so please dictate it again.
                    {localParakeetInstalled && entry.audioAvailable
                      ? " Try anyway runs it through Parakeet on this Mac."
                      : ""}
                    {entry.rawCaptureAvailable
                      ? " The raw capture stays on this Mac until this recording expires."
                      : ""}
                  </p>
                ) : null}
                {earlierAttempt ? (
                  <div className="mt-1.5 rounded-[var(--fd-radius-md)] bg-surface-1 px-2.5 py-2">
                    <p className="text-[length:var(--fd-text-xs)] font-medium text-fg-muted">
                      Earlier attempt, not a confirmed result
                    </p>
                    <p className="mt-0.5 line-clamp-3 text-[length:var(--fd-text-sm)] text-fg-secondary">
                      {earlierAttempt}
                    </p>
                  </div>
                ) : null}
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  {corrupted ? (
                    localParakeetInstalled ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!entry.audioAvailable || busyId !== null}
                        onClick={() => void retry(entry, true)}
                      >
                        {busyId === entry.id ? (
                          <ActivityDiamond size="sm" />
                        ) : (
                          <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                        )}
                        Try anyway
                      </Button>
                    ) : null
                  ) : (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={!entry.audioAvailable || busyId !== null || retryBlocked || (!baseUrl && !retriesLocally)}
                    onClick={() => void retry(entry)}
                  >
                    {busyId === entry.id ? (
                      <ActivityDiamond size="sm" />
                    ) : (
                      <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                    )}
                    Retry
                  </Button>
                  )}
                  {entry.text ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void copy(entry)}
                    >
                      {earlierAttempt ? "Copy earlier attempt" : "Copy transcript"}
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => void remove(entry)}
                  >
                    <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                    Delete
                  </Button>
                </div>
              </li>
              );
            })}
          </ul>
        )
      ) : null}
    </SettingsSection>
  );
}

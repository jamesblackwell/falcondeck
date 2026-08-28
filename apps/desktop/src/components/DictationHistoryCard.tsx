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
import {
  formatRecordedAt,
  formatRecordingLength,
  retentionSummary,
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
  const [retryModel, setRetryModel] = useState(
    settings.fallbackModel ?? settings.model,
  );
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

  // A dictation finishing (or failing) while this panel is open should show
  // up without reopening settings. The overlay events already broadcast the
  // terminal states to every window.
  useEffect(() => {
    if (!isTauriDesktop()) return;
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ state: string }>("falcondeck://dictation-state", (event) => {
        if (event.payload.state === "completed" || event.payload.state === "failed") {
          void refresh();
        }
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

  const retry = async (entry: DictationHistoryEntry) => {
    setBusyId(entry.id);
    try {
      const updated = await retryDictationHistoryEntry(entry.id, retryModel);
      setEntries((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      onToast({
        variant: "success",
        title: "Transcribed again",
        description: "Press ⌘⇧V to insert it, or copy it from the list.",
      });
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
            hint="Retrying sends the kept audio to this model instead of your usual one."
          >
            <select
              id="dictation-retry-model"
              className={SELECT_CLASS}
              value={retryModel}
              onChange={(event) => setRetryModel(event.target.value)}
            >
              {!models.some((model) => model.id === retryModel) ? (
                <option value={retryModel}>{retryModel}</option>
              ) : null}
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
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
            {entries.map((entry) => (
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
                  {entry.model ? (
                    <Badge variant="default">{entry.model}</Badge>
                  ) : (
                    <Badge variant="default">Apple Speech</Badge>
                  )}
                  {entry.error ? (
                    <Badge variant="danger" dot>
                      Failed
                    </Badge>
                  ) : null}
                  {!entry.audioAvailable ? (
                    <Badge variant="warning">Audio deleted</Badge>
                  ) : null}
                </div>
                <p
                  className={
                    entry.error && !entry.text
                      ? "mt-1.5 text-[length:var(--fd-text-sm)] text-danger"
                      : "mt-1.5 line-clamp-3 text-[length:var(--fd-text-sm)] text-fg-primary"
                  }
                >
                  {entry.text ?? entry.error ?? "No transcript"}
                </p>
                <div className="mt-2.5 flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={
                      !entry.audioAvailable || busyId === entry.id || !baseUrl
                    }
                    onClick={() => void retry(entry)}
                  >
                    {busyId === entry.id ? (
                      <ActivityDiamond size="sm" />
                    ) : (
                      <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                    )}
                    Retry
                  </Button>
                  {entry.text ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void copy(entry)}
                    >
                      Copy transcript
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
            ))}
          </ul>
        )
      ) : null}
    </SettingsSection>
  );
}

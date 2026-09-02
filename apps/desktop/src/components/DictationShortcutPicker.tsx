import { useEffect, useRef, useState } from "react";

import { Button, cn } from "@falcondeck/ui";

import {
  DICTATION_SHORTCUT_SUGGESTIONS,
  dictationShortcutFromEvent,
  dictationShortcutLabel,
  dictationShortcutTokens,
  dictationShortcutValidation,
  isModifierOnlyDictationShortcut,
  type DictationShortcutSuggestion,
} from "../dictation-shortcut";

function Keycaps({ shortcut }: { shortcut: string }) {
  return (
    <span className="inline-flex items-center gap-1" aria-hidden="true">
      {dictationShortcutTokens(shortcut).map((token, index) => (
        <kbd
          key={`${token}-${index}`}
          className="inline-flex min-w-6 items-center justify-center rounded-[var(--fd-radius-sm)] border border-border-default bg-surface-1 px-1.5 py-0.5 font-mono text-[length:var(--fd-text-xs)] font-medium text-fg-secondary shadow-[inset_0_-1px_0_var(--color-border-default)]"
        >
          {token}
        </kbd>
      ))}
    </span>
  )
}

function optionClass(selected: boolean) {
  return cn(
    "fd-focus rounded-[var(--fd-radius-md)] border px-2.5 py-1.5 text-left text-[length:var(--fd-text-xs)] font-medium transition-colors",
    selected
      ? "border-accent/50 bg-accent/10 text-fg-primary"
      : "border-border-subtle bg-surface-2 text-fg-secondary hover:bg-surface-3",
  )
}

type DictationShortcutPickerProps = {
  id: string;
  value: string;
  label?: string;
  suggested?: readonly DictationShortcutSuggestion[];
  reserved?: string[];
  reservedLabel?: string;
  onChange: (shortcut: string) => void;
};

export function DictationShortcutPicker({
  id,
  value,
  label = "Shortcut",
  suggested = DICTATION_SHORTCUT_SUGGESTIONS,
  reserved = [],
  reservedLabel = "the other speech shortcut",
  onChange,
}: DictationShortcutPickerProps) {
  const [recording, setRecording] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const previewRef = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const suggestedIds = new Set(suggested.map((item) => item.id));
  const customSelected = !suggestedIds.has(value);
  const previewValidation = preview ? dictationShortcutValidation(preview) : null;
  const previewReserved =
    preview && reserved.includes(preview)
      ? `Already used by ${reservedLabel}.`
      : null;

  const setPreviewValue = (next: string | null) => {
    previewRef.current = next;
    setPreview(next);
  };

  useEffect(() => {
    if (recording) inputRef.current?.focus();
  }, [recording]);

  const commit = (shortcut: string) => {
    onChange(shortcut);
    setRecording(false);
    setPreviewValue(null);
  };

  return (
    <div className="space-y-2">
      <div
        id={id}
        role="group"
        aria-label={label}
        className="flex flex-wrap items-center gap-2"
      >
        {suggested.map((item) => {
          const selected = !recording && value === item.id;
          return (
            <button
              key={item.id}
              type="button"
              aria-pressed={selected}
              aria-label={item.label}
              disabled={reserved.includes(item.id)}
              onClick={() => commit(item.id)}
              className={optionClass(selected)}
            >
              {item.label}
            </button>
          );
        })}
        {customSelected ? (
          <button
            type="button"
            aria-pressed={!recording}
            aria-label={dictationShortcutLabel(value)}
            onClick={() => setRecording(false)}
            className={optionClass(!recording)}
          >
            <Keycaps shortcut={value} />
          </button>
        ) : null}
        <Button
          type="button"
          size="sm"
          variant={recording ? "default" : "secondary"}
          onClick={() => {
            setRecording((current) => !current);
            setPreviewValue(null);
          }}
        >
          {recording ? "Cancel" : "Record shortcut"}
        </Button>
      </div>
      {recording ? (
        <div className="rounded-[var(--fd-radius-lg)] border border-accent/40 bg-accent-muted p-3">
          <div className="flex min-h-9 items-center">
            {preview ? (
              <span className="inline-flex items-center gap-2">
                <Keycaps shortcut={preview} />
                <span className="sr-only">{dictationShortcutLabel(preview)}</span>
              </span>
            ) : (
              <span className="text-[length:var(--fd-text-sm)] text-fg-secondary">
                Press the shortcut you want…
              </span>
            )}
          </div>
          <input
            ref={inputRef}
            aria-label="Record dictation shortcut"
            className="pointer-events-none absolute h-px w-px opacity-0"
            onKeyDown={(event) => {
              event.stopPropagation();
              const unmodified =
                !event.metaKey &&
                !event.ctrlKey &&
                !event.altKey &&
                !event.shiftKey;
              if (event.key === "Tab" && unmodified) return;
              event.preventDefault();
              if (event.key === "Escape" && unmodified) {
                setRecording(false);
                setPreviewValue(null);
                return;
              }
              const next = dictationShortcutFromEvent(event.nativeEvent);
              if (next) setPreviewValue(next);
            }}
            onKeyUp={(event) => {
              event.stopPropagation();
              event.preventDefault();
              const candidate = previewRef.current;
              if (!candidate) return;
              if (dictationShortcutValidation(candidate)) return;
              if (reserved.includes(candidate)) return;
              if (isModifierOnlyDictationShortcut(candidate)) {
                if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
                  return;
                }
                commit(candidate);
                return;
              }
              if (
                event.key === "Meta" ||
                event.key === "Control" ||
                event.key === "Alt" ||
                event.key === "Shift" ||
                event.key === "Fn" ||
                event.key === "CapsLock"
              ) {
                return;
              }
              commit(candidate);
            }}
          />
          {previewValidation ? (
            <p role="alert" className="mt-2 text-[length:var(--fd-text-xs)] text-danger">
              {previewValidation}
            </p>
          ) : previewReserved ? (
            <p role="alert" className="mt-2 text-[length:var(--fd-text-xs)] text-danger">
              {previewReserved}
            </p>
          ) : (
            <p className="mt-2 text-[length:var(--fd-text-xs)] text-fg-muted">
              Suggested keys are at the top. Escape cancels. The shortcut applies
              as soon as you release it.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}

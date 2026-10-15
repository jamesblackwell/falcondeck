import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Button, Field, Input, SettingsSection } from "@falcondeck/ui";
import { isTauriDesktop } from "../api";

type Correction = { find: string; replace: string };
export const DICTIONARY_REQUEST_KEY = "falcondeck.dictation.dictionary-request";
export const DICTIONARY_REQUEST_EVENT = "falcondeck:open-dictation-dictionary";

export function DictationDictionary() {
  const [entries, setEntries] = useState<Correction[]>([]);
  const [find, setFind] = useState("");
  const [replacement, setReplacement] = useState("");
  const [transcript, setTranscript] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const focusRequested = useRef(false);

  useEffect(() => {
    if (!isTauriDesktop()) return;
    let disposed = false;
    void invoke<Correction[]>("dictation_dictionary").then((value) => {
      if (!disposed) { setEntries(value); setReady(true); }
    }, (error) => { if (!disposed) setError(String(error)); });
    const open = () => {
      const requested = sessionStorage.getItem(DICTIONARY_REQUEST_KEY);
      if (requested === null) return;
      sessionStorage.removeItem(DICTIONARY_REQUEST_KEY);
      focusRequested.current = true;
      setTranscript(requested || null);
      findRef.current?.scrollIntoView?.({ block: "center" });
      findRef.current?.focus();
    };
    open();
    window.addEventListener(DICTIONARY_REQUEST_EVENT, open);
    return () => { disposed = true; window.removeEventListener(DICTIONARY_REQUEST_EVENT, open); };
  }, []);

  useEffect(() => {
    if (!ready || !focusRequested.current) return;
    findRef.current?.scrollIntoView?.({ block: "center" });
    findRef.current?.focus();
  }, [ready]);

  const save = async (next: Correction[]) => {
    setPending(true); setError(null);
    try {
      await invoke("save_dictation_dictionary", { entries: next });
      setEntries(next);
      return true;
    } catch (error) { setError(String(error)); return false; }
    finally { setPending(false); }
  };

  if (!isTauriDesktop()) return null;
  return (
    <SettingsSection title="Correction dictionary" description="Replace recurring transcription mistakes with your preferred spelling. Matches whole words and phrases, ignores case, and works locally with every transcription engine.">
      {transcript ? <p className="max-h-36 overflow-y-auto whitespace-pre-wrap rounded-[var(--fd-radius-md)] bg-surface-2 p-3 text-sm text-fg-secondary">{transcript}</p> : null}
      <form className="space-y-3" onSubmit={(event) => {
        event.preventDefault();
        const correction = { find: find.trim(), replace: replacement.trim() };
        const next = entries.filter((entry) => entry.find.toLowerCase() !== correction.find.toLowerCase());
        void save([...next, correction]).then((saved) => { if (saved) { setFind(""); setReplacement(""); } });
      }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Heard as" htmlFor="dictation-dictionary-find"><Input ref={findRef} id="dictation-dictionary-find" value={find} maxLength={200} placeholder="Larab" disabled={!ready || pending} onChange={(event) => setFind(event.target.value)} /></Field>
          <Field label="Replace with" htmlFor="dictation-dictionary-replace" hint="Leave blank to remove the word or phrase."><Input id="dictation-dictionary-replace" value={replacement} maxLength={200} placeholder="Leave blank to remove" disabled={!ready || pending} onChange={(event) => setReplacement(event.target.value)} /></Field>
        </div>
        <Button type="submit" variant="secondary" disabled={!ready || pending || !find.trim()}>Save correction</Button>
        <p className="text-sm text-fg-muted">Saved corrections apply to future transcriptions. Saving the same heard spelling updates its replacement.</p>
      </form>
      {entries.length ? <ul className="divide-y divide-border-subtle">
        {entries.map((entry) => <li key={entry.find} className="flex items-center gap-3 py-2">
          <span className="min-w-0 flex-1 break-words text-sm text-fg-primary">{entry.find} → {entry.replace || "(remove)"}</span>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => { setFind(entry.find); setReplacement(entry.replace); findRef.current?.focus(); }}>Edit</Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} aria-label={`Remove correction for ${entry.find}`} onClick={() => void save(entries.filter((item) => item.find !== entry.find))}>Remove</Button>
        </li>)}
      </ul> : ready ? <p className="text-sm text-fg-muted">No saved corrections yet.</p> : null}
      {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    </SettingsSection>
  );
}

import { useCallback, useEffect, useState } from "react";

import { createDaemonApiClient } from "@falcondeck/client-core";
import { Button, Field, Input } from "@falcondeck/ui";
import {
  ExternalLink,
  KeyRound,
  ShieldCheck,
  Trash2,
} from "lucide-react";

import type { DictationSetupToast } from "../DictationSetup";

const OPENROUTER_KEYS_URL = "https://openrouter.ai/keys";

type OpenRouterKeyFieldProps = {
  baseUrl: string | null;
  onToast: (toast: DictationSetupToast) => void;
  id: string;
  hint: string;
};

/** Masked OpenRouter key field against the daemon secret, used by
 * Settings → Models & keys. */
export function OpenRouterKeyField({
  baseUrl,
  onToast,
  id,
  hint,
}: OpenRouterKeyFieldProps) {
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [credentialBusy, setCredentialBusy] = useState(false);

  const loadCredential = useCallback(async () => {
    if (!baseUrl) {
      setConfigured(null);
      return;
    }
    try {
      const next = (
        await createDaemonApiClient(baseUrl).speechCredentialStatus()
      ).configured;
      setConfigured(next);
    } catch {
      setConfigured(null);
    }
  }, [baseUrl]);

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
              ? "Checking OpenRouter key…"
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

import { useCallback, useEffect, useState } from "react";

import { createDaemonApiClient } from "@falcondeck/client-core";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from "@falcondeck/ui";
import { KeyRound, ShieldCheck, Trash2 } from "lucide-react";

type SpeechSettingsPanelProps = {
  baseUrl: string | null;
  onToast: (toast: {
    variant: "success" | "danger" | "warning" | "default";
    title: string;
    description?: string;
  }) => void;
};

export function SpeechSettingsPanel({
  baseUrl,
  onToast,
}: SpeechSettingsPanelProps) {
  const [apiKey, setApiKey] = useState("");
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!baseUrl) return;
    try {
      setConfigured(
        (await createDaemonApiClient(baseUrl).speechCredentialStatus())
          .configured,
      );
    } catch (error) {
      setConfigured(null);
      onToast({
        variant: "danger",
        title: "Could not read speech settings",
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [baseUrl, onToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    const cleaned = apiKey.trim();
    if (!baseUrl || !cleaned) return;
    setBusy(true);
    try {
      const status =
        await createDaemonApiClient(baseUrl).saveSpeechCredential(cleaned);
      setConfigured(status.configured);
      setApiKey("");
      onToast({
        variant: "success",
        title: "OpenRouter key saved",
        description:
          "The key is held only in this computer’s OS credential store.",
      });
    } catch (error) {
      onToast({
        variant: "danger",
        title: "Could not save OpenRouter key",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!baseUrl) return;
    setBusy(true);
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
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[length:var(--fd-text-2xl)] font-semibold text-fg-primary">
          Speech
        </h1>
        <p className="mt-2 text-[length:var(--fd-text-sm)] text-fg-muted">
          Configure cloud transcription for paired mobile devices.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound aria-hidden="true" className="h-4 w-4" />
            OpenRouter
          </CardTitle>
          <CardDescription>
            The daemon uses this key to transcribe audio sent through
            FalconDeck’s encrypted relay. The key never leaves this computer and
            is never written to FalconDeck configuration.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 px-3 py-2 text-[length:var(--fd-text-sm)]">
            <ShieldCheck aria-hidden="true" className="h-4 w-4 text-success" />
            <span className="text-fg-secondary">
              {configured === null
                ? "Checking OS credential store…"
                : configured
                  ? "Configured in the OS credential store"
                  : "No OpenRouter key configured"}
            </span>
          </div>
          <div className="space-y-2">
            <label
              htmlFor="openrouter-speech-key"
              className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary"
            >
              {configured ? "Replace API key" : "API key"}
            </label>
            <Input
              id="openrouter-speech-key"
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
                onClick={() => void remove()}
                disabled={busy}
              >
                <Trash2 aria-hidden="true" className="h-4 w-4" />
                Remove
              </Button>
            ) : null}
            <Button
              onClick={() => void save()}
              disabled={busy || !apiKey.trim()}
            >
              {busy ? "Saving…" : "Save key"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

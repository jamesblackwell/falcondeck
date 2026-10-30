import { useState } from "react";
import type {
  CloudSettings,
  UpdateCloudSettingsRequest,
} from "@falcondeck/client-core";
import {
  Button,
  Field,
  Input,
  SettingsSection,
  SwitchRow,
  Textarea,
} from "@falcondeck/ui";
import type { CloudApi } from "./cloud-api";

export function CloudSettingsForm({
  api,
  settings,
  onSaved,
}: {
  api: CloudApi;
  settings: CloudSettings;
  onSaved: (settings: CloudSettings) => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [providerToken, setProviderToken] = useState("");
  const [openaiKey, setOpenaiKey] = useState("");
  const [clearProvider, setClearProvider] = useState(false);
  const [clearOpenai, setClearOpenai] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const field = <K extends keyof CloudSettings>(
    key: K,
    value: CloudSettings[K],
  ) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setSaved(false);
  };
  async function save(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setSaved(false);
    const request: UpdateCloudSettingsRequest = {
      enabled: draft.enabled,
      team_id: draft.team_id ?? "",
      project_id: draft.project_id ?? "",
      image: draft.image,
      timeout_minutes: draft.timeout_minutes,
      node_binary: draft.node_binary,
      runtime_path: draft.runtime_path,
      worker_daemon_url: draft.worker_daemon_url,
      worker_daemon_sha256: draft.worker_daemon_sha256,
      allowed_domains: draft.allowed_domains
        .map((domain) => domain.trim())
        .filter(Boolean),
      ...(clearProvider
        ? { provider_token: "" }
        : providerToken
          ? { provider_token: providerToken }
          : {}),
      ...(clearOpenai
        ? { openai_api_key: "" }
        : openaiKey
          ? { openai_api_key: openaiKey }
          : {}),
    };
    try {
      const next = await api.updateSettings(request);
      setDraft(next);
      setProviderToken("");
      setOpenaiKey("");
      setClearProvider(false);
      setClearOpenai(false);
      setSaved(true);
      onSaved(next);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Cloud settings could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }
  return (
    <form onSubmit={(event) => void save(event)} className="space-y-5">
      <SettingsSection
        title="Cloud tasks"
        description="Run a native Codex task in an isolated Vercel sandbox. Credentials stay on the selected host. Saving settings does not start compute."
      >
        <SwitchRow
          title="Enable cloud tasks"
          checked={draft.enabled}
          onCheckedChange={(value) => field("enabled", value)}
        />
        <div className="space-y-4 pt-4">
          <Field
            label="Vercel access token"
            htmlFor="cloud-provider-token"
            hint={
              settings.has_provider_token
                ? "A token is saved. Leave this empty to keep it."
                : "No token saved."
            }
          >
            <Input
              id="cloud-provider-token"
              type="password"
              autoComplete="new-password"
              value={providerToken}
              disabled={saving || clearProvider}
              onChange={(event) => {
                setProviderToken(event.target.value);
                setSaved(false);
              }}
            />
          </Field>
          {settings.has_provider_token ? (
            <label className="flex items-center gap-2 text-sm text-fg-secondary">
              <input
                type="checkbox"
                checked={clearProvider}
                disabled={saving}
                onChange={(event) => {
                  setClearProvider(event.target.checked);
                  setSaved(false);
                }}
              />
              Remove saved Vercel token
            </label>
          ) : null}
          <Field
            label="OpenAI API key"
            htmlFor="cloud-openai-key"
            hint={
              settings.has_openai_api_key
                ? "A key is saved. Leave this empty to keep it."
                : "No API key saved."
            }
          >
            <Input
              id="cloud-openai-key"
              type="password"
              autoComplete="new-password"
              value={openaiKey}
              disabled={saving || clearOpenai}
              onChange={(event) => {
                setOpenaiKey(event.target.value);
                setSaved(false);
              }}
            />
          </Field>
          {settings.has_openai_api_key ? (
            <label className="flex items-center gap-2 text-sm text-fg-secondary">
              <input
                type="checkbox"
                checked={clearOpenai}
                disabled={saving}
                onChange={(event) => {
                  setClearOpenai(event.target.checked);
                  setSaved(false);
                }}
              />
              Remove saved OpenAI key
            </label>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Vercel team ID" htmlFor="cloud-team">
              <Input
                id="cloud-team"
                value={draft.team_id ?? ""}
                onChange={(event) => field("team_id", event.target.value)}
              />
            </Field>
            <Field label="Vercel project ID" htmlFor="cloud-project">
              <Input
                id="cloud-project"
                value={draft.project_id ?? ""}
                onChange={(event) => field("project_id", event.target.value)}
              />
            </Field>
          </div>
          <Field
            label="Maximum runtime (minutes)"
            htmlFor="cloud-timeout"
            hint="The sandbox remains billable until it is stopped or expires."
          >
            <Input
              id="cloud-timeout"
              type="number"
              min={1}
              max={1440}
              required
              value={draft.timeout_minutes}
              onChange={(event) =>
                field("timeout_minutes", Number(event.target.value))
              }
            />
          </Field>
        </div>
      </SettingsSection>
      <SettingsSection
        title="Worker setup"
        description="Configure the runtime adapter and worker image. The image can include the daemon, or download a pinned binary."
      >
        <div className="space-y-4">
          <Field label="Worker image" htmlFor="cloud-image">
            <Input
              id="cloud-image"
              required
              value={draft.image}
              onChange={(event) => field("image", event.target.value)}
            />
          </Field>
          <Field label="Node executable" htmlFor="cloud-node">
            <Input
              id="cloud-node"
              required
              value={draft.node_binary}
              onChange={(event) => field("node_binary", event.target.value)}
            />
          </Field>
          <Field label="Runtime adapter path" htmlFor="cloud-runtime">
            <Input
              id="cloud-runtime"
              value={draft.runtime_path}
              onChange={(event) => field("runtime_path", event.target.value)}
            />
          </Field>
          <Field
            label="Worker daemon URL"
            htmlFor="cloud-daemon-url"
            hint="Leave the URL and SHA-256 empty when the image already includes falcondeck-daemon."
          >
            <Input
              id="cloud-daemon-url"
              type="url"
              value={draft.worker_daemon_url}
              onChange={(event) =>
                field("worker_daemon_url", event.target.value)
              }
            />
          </Field>
          <Field label="Worker daemon SHA-256" htmlFor="cloud-daemon-sha">
            <Input
              id="cloud-daemon-sha"
              value={draft.worker_daemon_sha256}
              onChange={(event) =>
                field("worker_daemon_sha256", event.target.value)
              }
            />
          </Field>
          <Field
            label="Allowed network domains"
            htmlFor="cloud-domains"
            hint="One domain per line. These domains are the worker's network allowlist."
          >
            <Textarea
              id="cloud-domains"
              value={draft.allowed_domains.join("\n")}
              onChange={(event) =>
                field("allowed_domains", event.target.value.split("\n"))
              }
              onBlur={() =>
                field(
                  "allowed_domains",
                  draft.allowed_domains
                    .map((domain) => domain.trim())
                    .filter(Boolean),
                )
              }
            />
          </Field>
        </div>
      </SettingsSection>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="text-sm text-success">
          Cloud settings saved.
        </p>
      ) : null}
      <Button type="submit" disabled={saving}>
        {saving ? "Saving…" : "Save cloud settings"}
      </Button>
    </form>
  );
}

import { useCallback, useEffect, useState } from "react";

import type { AgentControlSettings, ControlAuditEntry } from "@falcondeck/client-core";
import {
  ActivityDiamond,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from "@falcondeck/ui";
import { ShieldCheck } from "lucide-react";

import {
  ControlRequestError,
  listAudit,
  readSettings,
  updateSettings,
} from "../../control-api";

export type AgentControlPanelProps = {
  baseUrl: string | null;
  onToast: (toast: {
    variant: "success" | "danger" | "warning" | "default";
    title: string;
    description?: string;
  }) => void;
};

/** Providers the panel offers explicit toggles for. Additional overrides
 * recorded through the control API are shown as they exist. */
const TOGGLE_PROVIDERS = ["codex", "claude"];

export function AgentControlPanel({ baseUrl, onToast }: AgentControlPanelProps) {
  const [settings, setSettings] = useState<AgentControlSettings | null>(null);
  const [audit, setAudit] = useState<ControlAuditEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [busyField, setBusyField] = useState<string | null>(null);
  const [timezoneDraft, setTimezoneDraft] = useState("");

  const load = useCallback(async () => {
    if (!baseUrl) return;
    setLoadError(null);
    setIsLoading(true);
    try {
      const [nextSettings, nextAudit] = await Promise.all([
        readSettings(baseUrl),
        listAudit(baseUrl).catch(() => [] as ControlAuditEntry[]),
      ]);
      setSettings(nextSettings);
      setTimezoneDraft(nextSettings.default_timezone);
      setAudit(nextAudit);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoading(false);
    }
  }, [baseUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (field: string, arguments_: Parameters<typeof updateSettings>[1]) => {
      if (!baseUrl) return;
      setBusyField(field);
      try {
        const next = await updateSettings(baseUrl, arguments_);
        setSettings(next);
        onToast({ variant: "success", title: "Agent control settings saved" });
      } catch (error) {
        const description =
          error instanceof ControlRequestError
            ? error.detail?.suggested_action ?? error.message
            : error instanceof Error
              ? error.message
              : String(error);
        onToast({ variant: "danger", title: "Could not save settings", description });
      } finally {
        setBusyField(null);
      }
    },
    [baseUrl, onToast],
  );

  const providerIds = Array.from(
    new Set([...TOGGLE_PROVIDERS, ...Object.keys(settings?.providers ?? {})]),
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[length:var(--fd-text-2xl)] font-semibold text-fg-primary">
          Agent control
        </h1>
        <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-muted">
          FalconDeck exposes three conversational tools (falcondeck_search, falcondeck_get,
          falcondeck_execute) to agents you run. Disable control for the whole daemon or one
          provider; scheduled automations keep running either way.
        </p>
      </div>

      {loadError ? (
        <div className="flex items-center gap-3 rounded-[var(--fd-radius-lg)] border border-border-subtle px-4 py-3">
          <p className="min-w-0 flex-1 truncate text-[length:var(--fd-text-sm)] text-danger">
            {loadError}
          </p>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      ) : isLoading && !settings ? (
        <div className="flex items-center justify-center gap-2 px-2 py-10 text-[length:var(--fd-text-sm)] text-fg-muted">
          <ActivityDiamond size="md" />
          Loading agent control…
        </div>
      ) : settings ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Conversational control</CardTitle>
              <CardDescription>
                Applies to newly spawned agents and is enforced server-side on every
                MCP-originated request.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-3 rounded-[var(--fd-radius-lg)] border border-border-subtle px-4 py-3">
                <ShieldCheck className="h-4 w-4 shrink-0 text-fg-muted" />
                <div className="min-w-0 flex-1">
                  <span className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                    Agent control enabled
                  </span>
                  <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
                    Agents can discover and invoke FalconDeck capabilities conversationally.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={settings.enabled ? "secondary" : "default"}
                  aria-pressed={settings.enabled}
                  disabled={busyField === "enabled"}
                  onClick={() =>
                    void save("enabled", { enabled: !settings.enabled })
                  }
                >
                  {busyField === "enabled" ? <ActivityDiamond size="md" tone="current" /> : null}
                  {settings.enabled ? "Enabled" : "Disabled"}
                </Button>
              </div>

              {providerIds.map((provider) => {
                const override = settings.providers[provider];
                const enabled = override ? override.enabled : settings.enabled;
                return (
                  <div
                    key={provider}
                    className="flex items-center gap-3 rounded-[var(--fd-radius-lg)] border border-border-subtle px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="font-mono text-[length:var(--fd-text-sm)] text-fg-primary">
                        {provider}
                      </span>
                      <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
                        {override
                          ? "Explicit provider override"
                          : "Inherits the global setting"}
                      </p>
                    </div>
                    <Badge variant={enabled ? "success" : "default"}>
                      {enabled ? "Control on" : "Control off"}
                    </Badge>
                    <Button
                      size="sm"
                      variant="secondary"
                      aria-pressed={enabled}
                      aria-label={`Toggle agent control for ${provider}`}
                      disabled={busyField === `provider-${provider}`}
                      onClick={() =>
                        void save(`provider-${provider}`, {
                          providers: {
                            ...settings.providers,
                            // Without a stored override, pin the effective
                            // state instead of flipping it, so creating an
                            // override never surprises the user by turning
                            // control off.
                            [provider]: { enabled: override ? !enabled : enabled },
                          },
                        })
                      }
                    >
                      {busyField === `provider-${provider}` ? (
                        <ActivityDiamond size="md" tone="current" />
                      ) : null}
                      {override ? (enabled ? "Disable" : "Enable") : "Override"}
                    </Button>
                  </div>
                );
              })}

              <div className="flex items-center gap-3 rounded-[var(--fd-radius-lg)] border border-border-subtle px-4 py-3">
                <div className="min-w-0 flex-1">
                  <span className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                    Inject FalconDeck agent context
                  </span>
                  <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
                    Adds a short FalconDeck note and bundled control guide to agent
                    instructions. Applies on the next turn (Claude) or next agent
                    process start (Codex, ACP).
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={settings.inject_agent_context ? "secondary" : "default"}
                  aria-pressed={settings.inject_agent_context}
                  disabled={busyField === "agent-context"}
                  onClick={() =>
                    void save("agent-context", {
                      inject_agent_context: !settings.inject_agent_context,
                    })
                  }
                >
                  {settings.inject_agent_context ? "Injected" : "Off"}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Scheduling defaults</CardTitle>
              <CardDescription>
                Defaults offered when automations are created. The timezone must be an IANA
                identifier such as Europe/London.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-end gap-2">
                <label className="min-w-0 flex-1 space-y-1">
                  <span className="text-[length:var(--fd-text-xs)] text-fg-muted">
                    Default timezone
                  </span>
                  <Input
                    aria-label="Default timezone"
                    value={timezoneDraft}
                    onChange={(event) => setTimezoneDraft(event.target.value)}
                    placeholder="Europe/London"
                    className="font-mono"
                  />
                </label>
                <Button
                  size="sm"
                  disabled={
                    busyField === "timezone" ||
                    timezoneDraft.trim() === settings.default_timezone
                  }
                  onClick={() =>
                    void save("timezone", {
                      default_timezone: timezoneDraft.trim(),
                    })
                  }
                >
                  Save
                </Button>
              </div>

              <div className="flex items-center gap-3 rounded-[var(--fd-radius-lg)] border border-border-subtle px-4 py-3">
                <div className="min-w-0 flex-1">
                  <span className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                    Allow elevated automations
                  </span>
                  <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
                    Permit automations using bypassPermissions or danger-full-access. Elevated
                    automations are always badged in the list.
                  </p>
                </div>
                <Button
                  size="sm"
                  variant={settings.allow_elevated_automations ? "secondary" : "default"}
                  aria-pressed={settings.allow_elevated_automations}
                  disabled={busyField === "elevated"}
                  onClick={() =>
                    void save("elevated", {
                      allow_elevated_automations: !settings.allow_elevated_automations,
                    })
                  }
                >
                  {settings.allow_elevated_automations ? "Allowed" : "Blocked"}
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Confirmation preferences</CardTitle>
              <CardDescription>
                What clients should confirm before executing control operations. Applies to
                agents that surface FalconDeck confirmation prompts.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {(
                [
                  {
                    field: "destructive_operations" as const,
                    label: "Confirm destructive operations",
                    detail: "Ask before deleting automations or other destructive operations.",
                  },
                  {
                    field: "sensitive_operations" as const,
                    label: "Confirm sensitive operations",
                    detail: "Ask before settings changes and other sensitive mutations.",
                  },
                ]
              ).map((entry) => {
                const enabled = settings.confirmation_policy[entry.field];
                return (
                  <div
                    key={entry.field}
                    className="flex items-center gap-3 rounded-[var(--fd-radius-lg)] border border-border-subtle px-4 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <span className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                        {entry.label}
                      </span>
                      <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
                        {entry.detail}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant={enabled ? "secondary" : "default"}
                      aria-pressed={enabled}
                      aria-label={entry.label}
                      disabled={busyField === entry.field}
                      onClick={() =>
                        void save(entry.field, {
                          confirmation_policy: {
                            ...settings.confirmation_policy,
                            [entry.field]: !enabled,
                          },
                        })
                      }
                    >
                      {busyField === entry.field ? (
                        <ActivityDiamond size="md" tone="current" />
                      ) : null}
                      {enabled ? "Asking" : "Skipped"}
                    </Button>
                  </div>
                );
              })}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Recent control changes</CardTitle>
              <CardDescription>
                Mutations from agents, this interface and the scheduler, most recent first.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {audit.length === 0 ? (
                <p className="px-2 py-6 text-center text-[length:var(--fd-text-sm)] text-fg-muted">
                  No control changes recorded yet.
                </p>
              ) : (
                audit.map((entry) => (
                  <div
                    key={entry.id}
                    className="flex items-center gap-3 rounded-[var(--fd-radius-lg)] border border-border-subtle px-4 py-2.5"
                  >
                    <Badge variant={entry.result === "success" ? "success" : "danger"}>
                      {entry.result}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[length:var(--fd-text-sm)] text-fg-primary">
                        {entry.summary}
                      </p>
                      <p className="truncate font-mono text-[length:var(--fd-text-xs)] text-fg-muted">
                        {entry.context.origin}
                        {entry.context.provider ? ` · ${entry.context.provider}` : ""} ·{" "}
                        {new Date(entry.occurred_at).toLocaleString()}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}

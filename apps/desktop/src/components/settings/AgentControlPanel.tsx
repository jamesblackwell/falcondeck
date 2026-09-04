import { useCallback, useEffect, useState } from "react";

import {
  CONTROL_PROVIDER_CHOICES,
  type AgentControlSettings,
  type ControlAuditEntry,
} from "@falcondeck/client-core";
import {
  ActivityDiamond,
  Badge,
  Button,
  Field,
  SettingList,
  SettingRow,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
  Switch,
  Input,
} from "@falcondeck/ui";

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

export function AgentControlPanel({
  baseUrl,
  onToast,
}: AgentControlPanelProps) {
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
            ? (error.detail?.suggested_action ?? error.message)
            : error instanceof Error
              ? error.message
              : String(error);
        onToast({
          variant: "danger",
          title: "Could not save settings",
          description,
        });
      } finally {
        setBusyField(null);
      }
    },
    [baseUrl, onToast],
  );

  // First-class providers plus any extra overrides already stored.
  const providerIds = Array.from(
    new Set([
      ...CONTROL_PROVIDER_CHOICES,
      ...Object.keys(settings?.providers ?? {}),
    ]),
  );

  return (
    <SettingsPage>
      <SettingsPageHeader
        title="Agent control"
        description="FalconDeck exposes three conversational tools (falcondeck_search, falcondeck_get, falcondeck_execute) to agents you run. Disable control for the whole daemon or one provider; scheduled automations keep running either way."
      />

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
          <SettingsSection
            title="Conversational control"
            description="Applies to newly spawned agents and is enforced server-side on every MCP-originated request."
            contentClassName="pt-1"
          >
            <SettingList>
              <SettingRow
                title="Agent control enabled"
                description="Agents can discover and invoke FalconDeck capabilities conversationally."
                onActivate={() =>
                  void save("enabled", { enabled: !settings.enabled })
                }
                control={
                  busyField === "enabled" ? (
                    <ActivityDiamond size="md" />
                  ) : (
                    <Switch
                      label="Agent control enabled"
                      checked={settings.enabled}
                      onCheckedChange={(enabled) =>
                        void save("enabled", { enabled })
                      }
                    />
                  )
                }
              />

              {providerIds.map((provider) => {
                const override = settings.providers[provider];
                const enabled = override ? override.enabled : settings.enabled;
                const toggleProvider = () =>
                  void save(`provider-${provider}`, {
                    providers: {
                      ...settings.providers,
                      // Without a stored override, pin the effective state
                      // instead of flipping it, so creating an override never
                      // surprises the user by turning control off.
                      [provider]: { enabled: override ? !enabled : enabled },
                    },
                  });
                return (
                  <SettingRow
                    key={provider}
                    title={<span className="font-mono">{provider}</span>}
                    description={
                      override
                        ? "Explicit provider override"
                        : "Inherits the global setting"
                    }
                    onActivate={toggleProvider}
                    control={
                      <span className="flex items-center gap-2.5">
                        {override ? null : (
                          <span className="text-[length:var(--fd-text-xs)] text-fg-muted">
                            Inherited
                          </span>
                        )}
                        {busyField === `provider-${provider}` ? (
                          <ActivityDiamond size="md" />
                        ) : (
                          <Switch
                            label={`Toggle agent control for ${provider}`}
                            checked={enabled}
                            onCheckedChange={toggleProvider}
                          />
                        )}
                      </span>
                    }
                  />
                );
              })}

              <SettingRow
                title="Inject FalconDeck agent context"
                description="Adds a short FalconDeck note and bundled control guide to agent instructions. Applies on the next turn (Claude) or next agent process start (Codex, ACP)."
                onActivate={() =>
                  void save("agent-context", {
                    inject_agent_context: !settings.inject_agent_context,
                  })
                }
                control={
                  <Switch
                    label="Inject FalconDeck agent context"
                    checked={settings.inject_agent_context}
                    onCheckedChange={(inject_agent_context) =>
                      void save("agent-context", { inject_agent_context })
                    }
                  />
                }
              />
            </SettingList>
          </SettingsSection>

          <SettingsSection
            title="Scheduling defaults"
            description="Defaults offered when automations are created."
          >
            <Field
              label="Default timezone"
              hint="An IANA identifier such as Europe/London."
            >
              <div className="flex items-center gap-2">
                <Input
                  aria-label="Default timezone"
                  value={timezoneDraft}
                  onChange={(event) => setTimezoneDraft(event.target.value)}
                  placeholder="Europe/London"
                  className="max-w-xs font-mono"
                />
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
            </Field>

            <SettingList>
              <SettingRow
                title="Allow elevated automations"
                description="Permit automations using bypassPermissions or danger-full-access. Elevated automations are always badged in the list."
                onActivate={() =>
                  void save("elevated", {
                    allow_elevated_automations:
                      !settings.allow_elevated_automations,
                  })
                }
                control={
                  <Switch
                    label="Allow elevated automations"
                    checked={settings.allow_elevated_automations}
                    onCheckedChange={(allow_elevated_automations) =>
                      void save("elevated", { allow_elevated_automations })
                    }
                  />
                }
              />
            </SettingList>
          </SettingsSection>

          <SettingsSection
            title="Confirmation preferences"
            description="What clients should confirm before executing control operations. Applies to agents that surface FalconDeck confirmation prompts."
            contentClassName="pt-1"
          >
            <SettingList>
              {[
                {
                  field: "destructive_operations" as const,
                  label: "Confirm destructive operations",
                  detail:
                    "Ask before deleting automations or other destructive operations.",
                },
                {
                  field: "sensitive_operations" as const,
                  label: "Confirm sensitive operations",
                  detail:
                    "Ask before settings changes and other sensitive mutations.",
                },
              ].map((entry) => {
                const enabled = settings.confirmation_policy[entry.field];
                const toggleEntry = () =>
                  void save(entry.field, {
                    confirmation_policy: {
                      ...settings.confirmation_policy,
                      [entry.field]: !enabled,
                    },
                  });
                return (
                  <SettingRow
                    key={entry.field}
                    title={entry.label}
                    description={entry.detail}
                    onActivate={toggleEntry}
                    control={
                      busyField === entry.field ? (
                        <ActivityDiamond size="md" />
                      ) : (
                        <Switch
                          label={entry.label}
                          checked={enabled}
                          onCheckedChange={toggleEntry}
                        />
                      )
                    }
                  />
                );
              })}
            </SettingList>
          </SettingsSection>

          <SettingsSection
            title="Recent control changes"
            description="Mutations from agents, this interface and the scheduler, most recent first."
            contentClassName="space-y-2"
          >
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
                  <Badge
                    variant={entry.result === "success" ? "success" : "danger"}
                  >
                    {entry.result}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[length:var(--fd-text-sm)] text-fg-primary">
                      {entry.summary}
                    </p>
                    <p className="truncate font-mono text-[length:var(--fd-text-xs)] text-fg-muted">
                      {entry.context.origin}
                      {entry.context.provider
                        ? ` · ${entry.context.provider}`
                        : ""}{" "}
                      · {new Date(entry.occurred_at).toLocaleString()}
                    </p>
                  </div>
                </div>
              ))
            )}
          </SettingsSection>
        </>
      ) : null}
    </SettingsPage>
  );
}

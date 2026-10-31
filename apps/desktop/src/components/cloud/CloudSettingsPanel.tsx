import { useEffect, useState } from "react";
import type { CloudSettings } from "@falcondeck/client-core";
import { Button, Field, SettingsPage, SettingsPageHeader } from "@falcondeck/ui";
import { CloudSettingsForm } from "./CloudSettingsForm";
import type { CloudApi } from "./cloud-api";

export type CloudSettingsOwner = {
  id: string;
  label: string;
  api: CloudApi | null;
};

export function CloudSettingsPanel({
  owners,
  initialOwnerId,
}: {
  owners: readonly CloudSettingsOwner[];
  initialOwnerId?: string | null;
}) {
  const [ownerId, setOwnerId] = useState(initialOwnerId ?? owners[0]?.id ?? "local");
  const owner = owners.find((candidate) => candidate.id === ownerId);

  return (
    <SettingsPage>
      <SettingsPageHeader
        title="Cloud execution"
        description="Configure Vercel once, then choose Cloud when starting a conversation. Each conversation gets its own environment."
      />
      <Field
        label="Project host"
        htmlFor="cloud-settings-owner"
        hint="Settings and credentials are stored on the host that owns your project."
      >
        <select
          id="cloud-settings-owner"
          className="fd-focus h-9 w-full rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-2 px-3 text-sm text-fg-primary"
          value={ownerId}
          onChange={(event) => setOwnerId(event.target.value)}
        >
          {!owner ? <option value={ownerId}>Selected host unavailable</option> : null}
          {owners.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
          ))}
        </select>
      </Field>
      {owner?.api ? (
        <OwnerSettings key={owner.id} api={owner.api} />
      ) : (
        <p role="status" className="text-sm text-fg-muted">
          Connect the selected project host to configure Cloud execution.
        </p>
      )}
    </SettingsPage>
  );
}

function OwnerSettings({ api }: { api: CloudApi }) {
  const [loaded, setLoaded] = useState<{ api: CloudApi; settings: CloudSettings } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  useEffect(() => {
    let canceled = false;
    setLoaded(null);
    setError(null);
    void api.settings().then(
      (settings) => { if (!canceled) setLoaded({ api, settings }); },
      (reason: unknown) => {
        if (!canceled) setError(reason instanceof Error ? reason.message : "Cloud settings could not be loaded.");
      },
    );
    return () => { canceled = true; };
  }, [api, refreshKey]);

  if (error) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-danger">{error}</p>
        <Button variant="outline" size="sm" onClick={() => setRefreshKey((key) => key + 1)}>Retry</Button>
      </div>
    );
  }
  if (!loaded || loaded.api !== api) return <p role="status" className="text-sm text-fg-muted">Loading cloud settings…</p>;
  return (
    <CloudSettingsForm
      key={refreshKey}
      api={api}
      settings={loaded.settings}
      onSaved={(settings) => setLoaded((current) => current?.api === api ? { api, settings } : current)}
    />
  );
}

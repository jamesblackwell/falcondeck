import { useCallback, useEffect, useState } from "react";

import { createDaemonApiClient } from "@falcondeck/client-core";
import type { ComputerUseStatus } from "@falcondeck/client-core";
import {
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
  SwitchRow,
} from "@falcondeck/ui";

import { ComputerUseSetup, type ComputerUseSetupToast } from "../ComputerUseSetup";

type ComputerUsePanelProps = {
  baseUrl: string | null;
  onToast: (toast: ComputerUseSetupToast) => void;
};

export function ComputerUsePanel({ baseUrl, onToast }: ComputerUsePanelProps) {
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!baseUrl) {
      setStatus(null);
      return;
    }
    try {
      setStatus(await createDaemonApiClient(baseUrl).computerUse());
    } catch {
      setStatus(null);
    }
  }, [baseUrl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const patch = async (
    update: { enabled?: boolean; telemetry?: boolean; overlay?: boolean },
  ) => {
    if (!baseUrl) return;
    setSaving(true);
    try {
      setStatus(await createDaemonApiClient(baseUrl).updateComputerUse(update));
    } catch (error) {
      onToast({
        variant: "danger",
        title: "Could not update computer use",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  };

  const unavailable = status && !status.available;

  return (
    <SettingsPage>
      <SettingsPageHeader
        title="Computer use"
        description="Let agents click, type, and read apps on this Mac in the background. FalconDeck owns the two macOS grants; no second app is installed."
      />
      {unavailable ? (
        <p className="text-[length:var(--fd-text-sm)] text-fg-muted">
          Computer use is not available on this host. It only runs in the
          FalconDeck Mac app on macOS 14 or later, with the bundled driver.
        </p>
      ) : (
        <>
          <SettingsSection title="Agents on this Mac">
            <SwitchRow
              title="Allow agents to use this Mac"
              description="Off until you turn it on here or during setup. When on, every harness gets the cua-driver tools once both permissions are granted."
              checked={status?.enabled ?? false}
              disabled={saving || !baseUrl}
              onCheckedChange={(enabled) => void patch({ enabled })}
            />
            <SwitchRow
              title="Show the agent cursor"
              description="A pointer overlay follows agent clicks so you can see what is being controlled."
              checked={status?.overlay ?? true}
              disabled={saving || !baseUrl}
              onCheckedChange={(overlay) => void patch({ overlay })}
            />
            <SwitchRow
              title="Share anonymous driver telemetry with Cua"
              description="Off by default. FalconDeck never sends screen contents. This only toggles Cua's own content-free install metrics."
              checked={status?.telemetry ?? false}
              disabled={saving || !baseUrl}
              onCheckedChange={(telemetry) => void patch({ telemetry })}
            />
          </SettingsSection>
          <ComputerUseSetup
            baseUrl={baseUrl}
            onToast={onToast}
            onStatusChange={setStatus}
          />
        </>
      )}
    </SettingsPage>
  );
}

import { useCallback, useEffect, useState } from "react";

import { createDaemonApiClient } from "@falcondeck/client-core";
import type { ComputerUseSettingsUpdate, ComputerUseStatus } from "@falcondeck/client-core";
import {
  Button,
  SettingRow,
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
    update: ComputerUseSettingsUpdate,
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

  const openAgentBrowser = async () => {
    if (!baseUrl) return;
    try {
      await createDaemonApiClient(baseUrl).openAgentBrowser();
    } catch (error) {
      onToast({
        variant: "danger",
        title: "Could not open the agent browser",
        description: error instanceof Error ? error.message : String(error),
      });
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
          <SettingsSection title="Browser">
            <SettingRow
              title="Agent browser"
              description="Agents use a separate Chrome profile that stays signed in, so Chrome never asks to allow remote debugging. Open it to sign in to the sites agents need, then quit that Chrome (⌘Q). Agents cannot launch it while you have it open."
              control={
                <Button
                  variant="secondary"
                  onClick={() => void openAgentBrowser()}
                  disabled={!baseUrl || status?.enabled !== true}
                >
                  Open agent browser
                </Button>
              }
            />
            <SwitchRow
              title="Allow agents to use my personal Chrome profile"
              description="Only for tasks where you ask an agent to work in your own Chrome window. Chrome asks you to allow remote debugging each time an agent connects, and this grants broad access to live pages, cookies, and signed-in accounts."
              checked={status?.existing_profile ?? false}
              disabled={saving || !baseUrl || status?.existing_profile === undefined}
              onCheckedChange={(existing_profile) => void patch({ existing_profile })}
            />
            <p className="text-[length:var(--fd-text-sm)] text-fg-muted">
              Computer use must also be on. Changing the personal-profile setting
              restarts the driver and disconnects active computer-use sessions.
              Restart FalconDeck afterward to reconnect agent tools. Turning it
              off stops FalconDeck access but does not switch off Chrome’s
              remote-debugging setting.
            </p>
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

import { useEffect, useState } from "react";

import type {
  FalconDeckPreferences,
  RemoteStatusResponse,
  TrustedDevice,
  UpdatePreferencesPayload,
  WorkspaceSummary,
  ExtensionSnapshot,
} from "@falcondeck/client-core";

import type { AppUpdaterState } from "../hooks/useAppUpdater";
import type { HostManager, HostView } from "../hosts";
import { AgentsPanel } from "./settings/AgentsPanel";
import { AgentControlPanel } from "./settings/AgentControlPanel";
import { AppearanceSettingsPanel } from "./settings/AppearanceSettingsPanel";
import { ConnectorsPanel } from "./settings/ConnectorsPanel";
import { GeneralSettingsPanel } from "./settings/GeneralSettingsPanel";
import { HarnessesPanel } from "./settings/HarnessesPanel";
import { ExtensionsPanel } from "./settings/ExtensionsPanel";
import { KeyboardShortcutsPanel } from "./settings/KeyboardShortcutsPanel";
import { RemoteAccessPanel } from "./settings/RemoteAccessPanel";
import { ServersPanel, type ServersPanelProps } from "./settings/ServersPanel";
import { SettingsSidebar } from "./settings/SettingsSidebar";
import { BackupPanel } from "./settings/BackupPanel";
import { SpeechSettingsPanel } from "./settings/SpeechSettingsPanel";
import { UsagePanel } from "./settings/UsagePanel";
import type { SettingsSectionId } from "./settings/settings-utils";

export type SettingsViewProps = {
  /** Section shown when the view mounts so app-level deep links can land on a panel. */
  initialSection?: SettingsSectionId;
  /** Changes for every deep-link request, including repeats of the same section. */
  sectionRequestKey?: number;
  workspace?: WorkspaceSummary | null;
  localWorkspaces: WorkspaceSummary[];
  baseUrl: string | null;
  hostManager: HostManager;
  hosts: HostView[];
  onToast: ServersPanelProps["onToast"];
  preferences: FalconDeckPreferences | null;
  remoteStatus: RemoteStatusResponse | null;
  pairingLink: string | null;
  relayUrl: string;
  isStartingRemote: boolean;
  remoteControlsDisabled: boolean;
  remoteControlsUnavailableReason: string | null;
  revokingDeviceId: string | null;
  updater: AppUpdaterState;
  updaterProgressPercent: number | null;
  onUpdatePreferences: (payload: UpdatePreferencesPayload) => void;
  onStartPairing: () => void;
  onRefreshRemoteStatus: () => void;
  onRevokeDevice: (device: TrustedDevice) => void;
  onCheckForUpdates: () => void;
  onDownloadUpdate: () => void;
  onRestartToInstallUpdate: () => void;
  onShowOnboardingAtNextLaunch: () => void;
  onClose: () => void;
  extensions: ExtensionSnapshot;
  onSetExtensionEnabled: (
    extensionId: string,
    enabled: boolean,
  ) => Promise<void>;
  onSetExtensionPermission: (
    extensionId: string,
    permission: string,
    granted: boolean,
  ) => Promise<void>;
};

export function SettingsView(props: SettingsViewProps) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>(
    props.initialSection ?? "general",
  );

  useEffect(() => {
    setActiveSection(props.initialSection ?? "general");
  }, [props.initialSection, props.sectionRequestKey]);

  return (
    <section className="flex h-full min-h-0 bg-surface-1">
      <SettingsSidebar
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        onClose={props.onClose}
      />

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-10">
        <div className="mx-auto w-full max-w-4xl">
          {activeSection === "appearance" ? (
            <AppearanceSettingsPanel />
          ) : activeSection === "keyboard" ? (
            <KeyboardShortcutsPanel />
          ) : activeSection === "servers" ? (
            <ServersPanel
              baseUrl={props.baseUrl}
              manager={props.hostManager}
              hosts={props.hosts}
              onToast={props.onToast}
            />
          ) : activeSection === "agents" ? (
            <AgentsPanel baseUrl={props.baseUrl} onToast={props.onToast} />
          ) : activeSection === "agent-control" ? (
            <AgentControlPanel baseUrl={props.baseUrl} onToast={props.onToast} />
          ) : activeSection === "harnesses" ? (
            <HarnessesPanel
              baseUrl={props.baseUrl}
              hosts={props.hosts}
              onToast={props.onToast}
            />
          ) : activeSection === "usage" ? (
            <UsagePanel baseUrl={props.baseUrl} onToast={props.onToast} />
          ) : activeSection === "connectors" ? (
            <ConnectorsPanel
              baseUrl={props.baseUrl}
              workspaces={props.localWorkspaces.map((workspace) => ({
                id: workspace.id,
                path: workspace.path,
                kind: workspace.kind,
              }))}
              onToast={props.onToast}
            />
          ) : activeSection === "extensions" ? (
            <ExtensionsPanel
              extensions={props.extensions}
              onSetEnabled={props.onSetExtensionEnabled}
              onSetPermission={props.onSetExtensionPermission}
            />
          ) : activeSection === "speech" ? (
            <SpeechSettingsPanel
              baseUrl={props.baseUrl}
              onToast={props.onToast}
            />
          ) : activeSection === "backup" ? (
            <BackupPanel baseUrl={props.baseUrl} onToast={props.onToast} />
          ) : activeSection === "general" ? (
            <GeneralSettingsPanel
              workspace={props.workspace}
              preferences={props.preferences}
              updater={props.updater}
              updaterProgressPercent={props.updaterProgressPercent}
              onUpdatePreferences={props.onUpdatePreferences}
              onCheckForUpdates={props.onCheckForUpdates}
              onDownloadUpdate={props.onDownloadUpdate}
              onRestartToInstallUpdate={props.onRestartToInstallUpdate}
              onShowOnboardingAtNextLaunch={props.onShowOnboardingAtNextLaunch}
            />
          ) : (
            <RemoteAccessPanel
              remoteStatus={props.remoteStatus}
              pairingLink={props.pairingLink}
              relayUrl={props.relayUrl}
              isStartingRemote={props.isStartingRemote}
              remoteControlsDisabled={props.remoteControlsDisabled}
              remoteControlsUnavailableReason={
                props.remoteControlsUnavailableReason
              }
              revokingDeviceId={props.revokingDeviceId}
              onStartPairing={props.onStartPairing}
              onRefreshRemoteStatus={props.onRefreshRemoteStatus}
              onRevokeDevice={props.onRevokeDevice}
            />
          )}
        </div>
      </div>
    </section>
  );
}

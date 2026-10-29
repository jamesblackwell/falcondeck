import { useEffect, useRef, useState } from "react";

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
import { ConversationSettingsPanel } from "./settings/ConversationSettingsPanel";
import { GeneralSettingsPanel } from "./settings/GeneralSettingsPanel";
import { HarnessesPanel } from "./settings/HarnessesPanel";
import { ExtensionsPanel } from "./settings/ExtensionsPanel";
import { KeyboardShortcutsPanel } from "./settings/KeyboardShortcutsPanel";
import { ModelsKeysPanel } from "./settings/ModelsKeysPanel";
import { NotificationsSettingsPanel } from "./settings/NotificationsSettingsPanel";
import { RemoteAccessPanel } from "./settings/RemoteAccessPanel";
import { ServersPanel, type ServersPanelProps } from "./settings/ServersPanel";
import { SettingsSidebar } from "./settings/SettingsSidebar";
import { ComputerUsePanel } from "./settings/ComputerUsePanel";
import { AnalyticsPanel } from "./settings/AnalyticsPanel";
import { BackupPanel } from "./settings/BackupPanel";
import { SpeechSettingsPanel } from "./settings/SpeechSettingsPanel";
import type { SettingsSectionId } from "./settings/settings-utils";

/** Finds the element whose own text is exactly `title` (a section or row
 * heading) and returns the row or card around it. */
function findSettingAnchor(root: HTMLElement, title: string) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node.parentElement;
    if (!element || element.textContent?.trim() !== title) continue;
    return (
      element.closest<HTMLElement>("[data-settings-anchor]") ?? element
    );
  }
  return null;
}

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
  // A fresh object per request, so repeating the same search result still
  // scrolls to it again.
  const [focusRequest, setFocusRequest] = useState<{ setting: string } | null>(
    null,
  );
  const contentRef = useRef<HTMLDivElement>(null);

  const selectSection = (section: SettingsSectionId, setting?: string) => {
    setActiveSection(section);
    setFocusRequest(setting ? { setting } : null);
    if (!setting && contentRef.current) contentRef.current.scrollTop = 0;
  };

  useEffect(() => {
    selectSection(props.initialSection ?? "general");
    // Deep links fire on section or request-key changes only.
  }, [props.initialSection, props.sectionRequestKey]);

  // Panels load their data asynchronously, so poll briefly for the target.
  useEffect(() => {
    if (!focusRequest) return;
    let attempts = 0;
    let timer: number | undefined;
    const tryFocus = () => {
      const root = contentRef.current;
      const anchor = root ? findSettingAnchor(root, focusRequest.setting) : null;
      if (!anchor) {
        if (++attempts < 20) timer = window.setTimeout(tryFocus, 100);
        return;
      }
      const reduceMotion = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      anchor.scrollIntoView?.({
        block: "center",
        behavior: reduceMotion ? "auto" : "smooth",
      });
      if (!reduceMotion) {
        anchor.animate?.(
          [
            { boxShadow: "inset 0 0 0 2px var(--color-accent)" },
            { boxShadow: "inset 0 0 0 2px transparent" },
          ],
          { duration: 1800, easing: "ease-out" },
        );
      }
    };
    tryFocus();
    return () => window.clearTimeout(timer);
  }, [focusRequest]);

  return (
    <section className="flex h-full min-h-0 bg-surface-1">
      <SettingsSidebar
        activeSection={activeSection}
        onSelectSection={selectSection}
        onClose={props.onClose}
      />

      <div
        ref={contentRef}
        className="min-h-0 flex-1 overflow-y-auto px-8 py-10"
      >
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
          ) : activeSection === "notifications" ? (
            <NotificationsSettingsPanel
              preferences={props.preferences}
              onUpdatePreferences={props.onUpdatePreferences}
            />
          ) : activeSection === "conversations" ? (
            <ConversationSettingsPanel
              preferences={props.preferences}
              onUpdatePreferences={props.onUpdatePreferences}
            />
          ) : activeSection === "models" ? (
            <ModelsKeysPanel
              baseUrl={props.baseUrl}
              workspace={props.workspace}
              preferences={props.preferences}
              onUpdatePreferences={props.onUpdatePreferences}
              onToast={props.onToast}
            />
          ) : activeSection === "agents" ? (
            <AgentsPanel
              baseUrl={props.baseUrl}
              workspace={props.workspace}
              onToast={props.onToast}
            />
          ) : activeSection === "agent-control" ? (
            <AgentControlPanel baseUrl={props.baseUrl} onToast={props.onToast} />
          ) : activeSection === "harnesses" ? (
            <HarnessesPanel
              baseUrl={props.baseUrl}
              hosts={props.hosts}
              onToast={props.onToast}
            />
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
              onOpenModelsKeys={() => selectSection("models")}
            />
          ) : activeSection === "computer-use" ? (
            <ComputerUsePanel
              baseUrl={props.baseUrl}
              onToast={props.onToast}
            />
          ) : activeSection === "analytics" ? (
            <AnalyticsPanel baseUrl={props.baseUrl} onToast={props.onToast} />
          ) : activeSection === "backup" ? (
            <BackupPanel baseUrl={props.baseUrl} onToast={props.onToast} />
          ) : activeSection === "general" ? (
            <GeneralSettingsPanel
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

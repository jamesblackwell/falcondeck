/* Standalone settings fixture: `npm run dev` → /settings-qa.html.
   Renders the settings shell with stubbed props so page layout, hierarchy and
   spacing can be checked without launching the app or a daemon.
   `?section=<SettingsSectionId>` picks the panel,
   `?theme=light|dark` the mode, `?baseUrl=` points panels at a live daemon. */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { initAppearance, updateAppearance } from "@falcondeck/ui";

import { SettingsView } from "./components/SettingsView";
import type { SettingsSectionId } from "./components/settings/settings-utils";
import type { HostManager } from "./hosts";

import "./index.css";

initAppearance();
const params = new URLSearchParams(window.location.search);
const theme = params.get("theme");
if (theme === "light" || theme === "dark") {
  updateAppearance({ theme });
}
const baseUrl = params.get("baseUrl");
// Seed device-local settings for screenshots, e.g.
// ?dictation={"enabled":true,"provider":"open_router"}
const dictation = params.get("dictation");
if (dictation) {
  const key = "falcondeck.desktop.dictation.v2";
  const current = JSON.parse(window.localStorage.getItem(key) ?? "{}");
  window.localStorage.setItem(
    key,
    JSON.stringify({ ...current, ...JSON.parse(dictation) }),
  );
}

const UPDATER = {
  status: "upToDate" as const,
  currentVersion: "0.9.3",
  availableVersion: null,
  notes: null,
  publishedAt: null,
  lastCheckedAt: new Date("2026-08-27T09:12:00Z").toISOString(),
  downloadedBytes: 0,
  totalBytes: null,
  errorMessage: null,
  lastTrigger: null,
};

const CONNECTOR_WORKSPACES = [
  "falcondeck",
  "James",
  "lucidpic",
  "miner",
  "penta-quest",
  "quizgecko",
  "runpod-comfyui-workstation",
  "testsetgo",
].map((name) => ({
  id: `workspace-${name}`,
  path: `/Users/dev/${name}`,
  kind: "project" as const,
}));

const noop = () => {};

export function Fixture() {
  return (
    <div className="h-screen">
      <SettingsView
        initialSection={
          (params.get("section") as SettingsSectionId | null) ?? "speech"
        }
        workspace={null}
        localWorkspaces={CONNECTOR_WORKSPACES as never}
        baseUrl={baseUrl}
        hostManager={{} as HostManager}
        hosts={[]}
        onToast={noop}
        preferences={null}
        remoteStatus={null}
        pairingLink={null}
        relayUrl=""
        isStartingRemote={false}
        remoteControlsDisabled
        remoteControlsUnavailableReason="Fixture"
        revokingDeviceId={null}
        updater={UPDATER}
        updaterProgressPercent={null}
        onUpdatePreferences={noop}
        onStartPairing={noop}
        onRefreshRemoteStatus={noop}
        onRevokeDevice={noop}
        onCheckForUpdates={noop}
        onDownloadUpdate={noop}
        onRestartToInstallUpdate={noop}
        onShowOnboardingAtNextLaunch={noop}
        onClose={noop}
        extensions={{ extensions: [] } as never}
        onSetExtensionEnabled={async () => {}}
        onSetExtensionPermission={async () => {}}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);

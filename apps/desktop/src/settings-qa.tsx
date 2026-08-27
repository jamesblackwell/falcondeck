/* Standalone settings fixture: `npm run dev` → /settings-qa.html.
   Renders the settings shell with stubbed props so page layout, hierarchy and
   spacing can be checked without launching the app or a daemon.
   `?section=speech|general|appearance|keyboard` picks the panel,
   `?theme=light|dark` the mode, `?baseUrl=` points panels at a live daemon. */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";

import { initAppearance, updateAppearance } from "@falcondeck/ui";

import { AppearanceSettingsPanel } from "./components/settings/AppearanceSettingsPanel";
import { GeneralSettingsPanel } from "./components/settings/GeneralSettingsPanel";
import { KeyboardShortcutsPanel } from "./components/settings/KeyboardShortcutsPanel";
import { SettingsSidebar } from "./components/settings/SettingsSidebar";
import { SpeechSettingsPanel } from "./components/settings/SpeechSettingsPanel";
import type { SettingsSectionId } from "./components/settings/settings-utils";

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

function Fixture() {
  const [section, setSection] = useState<SettingsSectionId>(
    (params.get("section") as SettingsSectionId | null) ?? "speech",
  );

  return (
    <section className="flex h-screen min-h-0 bg-surface-1">
      <SettingsSidebar
        activeSection={section}
        onSelectSection={setSection}
        onClose={() => {}}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-10">
        <div className="mx-auto w-full max-w-4xl">
          {section === "appearance" ? (
            <AppearanceSettingsPanel />
          ) : section === "keyboard" ? (
            <KeyboardShortcutsPanel />
          ) : section === "general" ? (
            <GeneralSettingsPanel
              workspace={null}
              preferences={null}
              updater={UPDATER}
              updaterProgressPercent={null}
              onUpdatePreferences={() => {}}
              onCheckForUpdates={() => {}}
              onDownloadUpdate={() => {}}
              onRestartToInstallUpdate={() => {}}
              onShowOnboardingAtNextLaunch={() => {}}
            />
          ) : (
            <SpeechSettingsPanel baseUrl={baseUrl} onToast={() => {}} />
          )}
        </div>
      </div>
    </section>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);

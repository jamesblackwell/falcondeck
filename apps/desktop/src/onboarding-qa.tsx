/* Standalone first-run onboarding fixture: `npm run dev` → /onboarding-qa.html.
   Walks the real OnboardingWizard without launching Tauri. Appearance and
   dictation writes go to this browser's localStorage (same keys as the app).
   `?step=welcome|appearance|fonts|dictation|computerUse|openrouter|tools|project|finish` jumps
   in, `?theme=light|dark` picks the mode, `?workspaces=1` pretends a project
   is already connected, `?baseUrl=` points the OpenRouter + harness steps at
   a live daemon. */
import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import {
  createDaemonApiClient,
  type DaemonApiClient,
  type HarnessesOverview,
} from "@falcondeck/client-core";
import { Button, initAppearance, updateAppearance } from "@falcondeck/ui";

import {
  ONBOARDING_STEP_INDEX,
  ONBOARDING_STEPS,
  OnboardingWizard,
  type OnboardingToast,
} from "./components/OnboardingWizard";

import "./index.css";

initAppearance();
const params = new URLSearchParams(window.location.search);
const theme = params.get("theme");
if (theme === "light" || theme === "dark") {
  updateAppearance({ theme });
}
const dictation = params.get("dictation");
if (dictation) {
  const key = "falcondeck.desktop.dictation.v2";
  const current = JSON.parse(window.localStorage.getItem(key) ?? "{}");
  window.localStorage.setItem(
    key,
    JSON.stringify({ ...current, ...JSON.parse(dictation) }),
  );
}

const STEP_ALIASES: Record<string, number> = Object.fromEntries(
  ONBOARDING_STEPS.map((label, index) => [label.toLowerCase(), index]),
);
STEP_ALIASES.openrouter = ONBOARDING_STEP_INDEX.openrouter;
STEP_ALIASES.computeruse = ONBOARDING_STEP_INDEX.computerUse;
STEP_ALIASES["computer-use"] = ONBOARDING_STEP_INDEX.computerUse;
STEP_ALIASES.typography = ONBOARDING_STEP_INDEX.fonts;
STEP_ALIASES.type = ONBOARDING_STEP_INDEX.fonts;

function parseStep(value: string | null): number {
  if (!value) return 0;
  if (value in STEP_ALIASES) return STEP_ALIASES[value];
  const asNumber = Number(value);
  if (Number.isInteger(asNumber) && asNumber >= 0 && asNumber < ONBOARDING_STEPS.length) {
    return asNumber;
  }
  return 0;
}

const MOCK_OVERVIEW: HarnessesOverview = {
  host: "local",
  harnesses: [
    {
      id: "codex",
      label: "Codex",
      kind: "builtin",
      bin: "codex",
      resolved_path: "/usr/local/bin/codex",
      installed: true,
      version: "0.12.0",
      latest_version: "0.13.0",
      update_available: true,
      upgrade_command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
      account_status: "Logged in using ChatGPT",
    },
    {
      id: "claude",
      label: "Claude Code",
      kind: "builtin",
      bin: "claude",
      installed: true,
      version: "1.0.0",
      update_available: false,
      upgrade_command: "curl -fsSL https://claude.ai/install.sh | bash",
      account_status: "Logged in",
    },
    {
      id: "opencode",
      label: "OpenCode",
      kind: "detected",
      bin: "opencode",
      installed: false,
      upgrade_command: "curl -fsSL https://opencode.ai/install | bash",
    },
    {
      id: "custom-agent",
      label: "Custom Agent",
      kind: "detected",
      bin: "custom-agent",
      installed: false,
    },
  ],
};

function mockApi(): DaemonApiClient {
  return {
    refreshHarnesses: async () => MOCK_OVERVIEW,
    upgradeHarness: async () => {
      throw new Error("Install jobs need the desktop app and a live daemon.");
    },
    harnessUpgradeJob: async () => {
      throw new Error("Install jobs need the desktop app and a live daemon.");
    },
  } as unknown as DaemonApiClient;
}

function Fixture() {
  const [step, setStep] = useState(() => parseStep(params.get("step")));
  const [session, setSession] = useState(0);
  const [workspacesCount, setWorkspacesCount] = useState(
    Number(params.get("workspaces")) || 0,
  );
  const [completed, setCompleted] = useState<boolean | null>(null);
  const [toast, setToast] = useState<OnboardingToast | null>(null);
  const liveBaseUrl = params.get("baseUrl");
  const api = useMemo(
    () => (liveBaseUrl ? createDaemonApiClient(liveBaseUrl) : mockApi()),
    [liveBaseUrl],
  );

  const jumpTo = (index: number) => {
    setCompleted(null);
    setStep(index);
    setSession((current) => current + 1);
  };

  return (
    <div className="min-h-screen bg-surface-0">
      <div className="fixed inset-x-0 top-0 z-50 flex flex-wrap items-center gap-2 border-b border-border-subtle bg-surface-1/95 px-3 py-2 backdrop-blur-sm">
        <p className="pr-2 text-[length:var(--fd-text-xs)] font-medium text-fg-secondary">
          Onboarding QA
        </p>
        {ONBOARDING_STEPS.map((label, index) => (
          <Button
            key={label}
            type="button"
            size="sm"
            variant={index === step && completed === null ? "secondary" : "ghost"}
            onClick={() => jumpTo(index)}
          >
            {label}
          </Button>
        ))}
      </div>
      {toast ? (
        <div className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-1 px-4 py-2 text-[length:var(--fd-text-sm)] text-fg-primary shadow-[var(--fd-shadow-lg)]">
          {toast.title}
          {toast.description ? (
            <span className="ml-2 text-fg-muted">{toast.description}</span>
          ) : null}
        </div>
      ) : null}
      {completed !== null ? (
        <main className="flex min-h-screen items-center justify-center px-6 pt-16">
          <div className="w-full max-w-md space-y-3 rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 p-6 text-center">
            <p className="text-[length:var(--fd-text-lg)] font-medium text-fg-primary">
              Wizard closed
            </p>
            <p className="text-[length:var(--fd-text-sm)] text-fg-muted">
              {completed
                ? "Skip setup was pressed. The real app would mark onboarding complete and not nag again."
                : "Start using FalconDeck was pressed. The real app would write the completed flag."}
            </p>
            <Button type="button" onClick={() => jumpTo(0)}>
              Replay from welcome
            </Button>
          </div>
        </main>
      ) : (
        <OnboardingWizard
          key={session}
          api={api}
          baseUrl={liveBaseUrl}
          workspacesCount={workspacesCount}
          isImportingSessions={false}
          initialStep={step}
          overlayClassName="pt-12"
          onStepChange={setStep}
          onAddProject={() => {
            setWorkspacesCount((count) => count + 1);
            setToast({
              variant: "success",
              title: "Project connected",
              description: "Folder picker is desktop-only; this fixture just increments the count.",
            });
          }}
          onToast={(next) => setToast(next)}
          onComplete={(skipped) => setCompleted(skipped)}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);

import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  DaemonApiClient,
  HarnessesOverview,
  HarnessSummary,
} from "@falcondeck/client-core";
import { ProviderIcon } from "@falcondeck/chat-ui";
import {
  ActivityDiamond,
  Badge,
  Button,
  ThemeControls,
  cn,
} from "@falcondeck/ui";
import {
  CheckCircle2,
  CircleDashed,
  Download,
  FolderPlus,
  RefreshCw,
  Terminal,
} from "lucide-react";
import { DictationSetup } from "./DictationSetup";

export type OnboardingToast = {
  variant: "success" | "danger" | "warning" | "default";
  title: string;
  description?: string;
};

type OnboardingWizardProps = {
  api: DaemonApiClient | null;
  baseUrl: string | null;
  /** Live workspace count from the snapshot; the project step reads it so a rerun on a set-up machine renders as "already connected". */
  workspacesCount: number;
  /** True while the daemon imports the picked folder's sessions; keeps the picker from being re-invoked mid-import. */
  isImportingSessions: boolean;
  onAddProject: () => void;
  onToast: (toast: OnboardingToast) => void;
  /** Writes the completed flag (skipped=true when the user skips) and closes the wizard. */
  onComplete: (skipped: boolean) => void;
};

const STEPS = [
  "Welcome",
  "Appearance",
  "Dictation",
  "Tools",
  "Project",
  "Finish",
] as const;
const STEP_INDEX = {
  welcome: 0,
  appearance: 1,
  dictation: 2,
  tools: 3,
  project: 4,
  finish: 5,
} as const;
const JOB_POLL_INTERVAL_MS = 1500;

type ActiveJob = {
  jobId: string;
  harnessId: string;
  action: "install" | "update";
};

type MacNotificationPermission = "default" | "denied" | "granted" | "unsupported";

function harnessStatus(harness: HarnessSummary): {
  label: string;
  variant: "success" | "warning" | "default";
} {
  if (!harness.installed) return { label: "Not installed", variant: "default" };
  if (harness.update_available === true)
    return { label: "Update available", variant: "warning" };
  return { label: "Installed", variant: "success" };
}

export function OnboardingWizard({
  api,
  baseUrl,
  workspacesCount,
  isImportingSessions,
  onAddProject,
  onToast,
  onComplete,
}: OnboardingWizardProps) {
  const [step, setStep] = useState(0);
  const [overview, setOverview] = useState<HarnessesOverview | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isProbing, setIsProbing] = useState(false);
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null);
  const [jobLog, setJobLog] = useState<string[]>([]);
  const [notificationPermission, setNotificationPermission] =
    useState<MacNotificationPermission>("default");
  const [isRequestingPermission, setIsRequestingPermission] = useState(false);
  const pollRef = useRef<number | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    nextRef.current?.focus();
  }, [step]);

  const probeHarnesses = useCallback(async () => {
    if (!api) return;
    setIsProbing(true);
    try {
      setOverview(await api.refreshHarnesses());
      setLoadError(null);
    } catch (cause) {
      setLoadError(
        cause instanceof Error ? cause.message : "Failed to check tools",
      );
    } finally {
      setIsProbing(false);
    }
  }, [api]);

  // The tools step sequences its first probe only after the daemon is live
  // (the wizard itself is gated on a ready connection).
  useEffect(() => {
    if (step === STEP_INDEX.tools && !overview && !loadError && !isProbing) {
      void probeHarnesses();
    }
  }, [step, overview, loadError, isProbing, probeHarnesses]);

  useEffect(() => {
    if (!activeJob || !api) return
    const poll = async () => {
      try {
        const job = await api.harnessUpgradeJob(activeJob.jobId)
        setJobLog(job.log);
        if (job.status !== "running") {
          setActiveJob(null);
          onToast(
            job.status === "completed"
              ? {
                  variant: "success",
                  title: `${job.label} ${activeJob.action === "update" ? "updated" : "installed"}`,
                }
              : {
                  variant: "danger",
                  title: `${job.label} ${activeJob.action} failed`,
                  description:
                    job.error ?? "The install command reported an error.",
                },
          );
          void probeHarnesses();
        }
      } catch (cause) {
        if ((cause as { status?: number }).status === 404) {
          // Jobs are in-memory on the daemon; a 404 means a restart erased it.
          setActiveJob(null);
          onToast({
            variant: "warning",
            title: `${activeJob.harnessId} install status lost`,
            description:
              "The daemon restarted while the install was running. Check the harness version in Settings → Harnesses after a moment.",
          });
          return;
        }
        // Transient poll failures retry on the next tick.
      }
    };
    void poll();
    pollRef.current = window.setInterval(() => void poll(), JOB_POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current != null) window.clearInterval(pollRef.current);
    };
  }, [activeJob, api, onToast, probeHarnesses]);

  const startInstall = useCallback(
    async (harness: HarnessSummary) => {
      if (!api) return;
      try {
        const jobId = await api.upgradeHarness(harness.id);
        setJobLog([]);
        setActiveJob({
          jobId,
          harnessId: harness.id,
          action: harness.installed ? "update" : "install",
        });
      } catch (error) {
        onToast({
          variant: "danger",
          title: `Could not start ${harness.label} install`,
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [api, onToast],
  );

  // Read the current macOS notification state when the finish step opens so a
  // rerun on a machine that already granted renders as done.
  useEffect(() => {
    if (step !== STEP_INDEX.finish) return;
    let cancelled = false;
    void invoke<MacNotificationPermission>("macos_notification_permission_state")
      .then((state) => {
        if (!cancelled) setNotificationPermission(state);
      })
      .catch(() => {
        if (!cancelled) setNotificationPermission("unsupported");
      });
    return () => {
      cancelled = true;
    };
  }, [step]);

  const requestNotifications = useCallback(async () => {
    setIsRequestingPermission(true);
    try {
      const state = await invoke<MacNotificationPermission>(
        "request_macos_notification_permission",
      );
      setNotificationPermission(state);
    } catch {
      setNotificationPermission("unsupported");
    } finally {
      setIsRequestingPermission(false);
    }
  }, []);

  const installedCount =
    overview?.harnesses.filter((harness) => harness.installed).length ?? 0;
  const isLastStep = step === STEPS.length - 1;

  const trapDialogFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;

    const focusable = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-[var(--fd-overlay)] px-6 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
        onKeyDown={trapDialogFocus}
        className="flex max-h-full w-full max-w-2xl flex-col overflow-y-auto rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 shadow-[var(--fd-shadow-lg)]"
        // A setup assistant is modal: Escape does not dismiss it. Skip is an
        // explicit button so the choice is deliberate.
      >
        <div className="flex items-center justify-center gap-2 px-6 pt-8">
          {STEPS.map((label, index) => (
            <div key={label} className="flex items-center gap-2">
              <span
                aria-current={index === step ? "step" : undefined}
                className={cn(
                  "h-1.5 w-1.5 rounded-full transition-colors",
                  index === step
                    ? "bg-accent"
                    : index < step
                      ? "bg-accent/50"
                      : "bg-surface-3",
                )}
              />
              {index === step ? (
                <span className="text-[length:var(--fd-text-xs)] text-fg-muted">
                  {label}
                </span>
              ) : null}
            </div>
          ))}
        </div>

        <div className="flex-1 px-6 py-8">
          {step === STEP_INDEX.welcome ? (
            <div className="flex flex-col items-center gap-4 py-8 text-center">
              <div className="rounded-full bg-accent/10 p-4 text-accent">
                <Terminal aria-hidden="true" className="h-8 w-8" />
              </div>
              <h2
                id="onboarding-title"
                className="text-[length:var(--fd-text-2xl)] font-semibold text-fg-primary"
              >
                Welcome to FalconDeck
              </h2>
              <p className="max-w-md text-[length:var(--fd-text-sm)] text-fg-muted">
                FalconDeck orchestrates coding agents — Codex, Claude Code,
                OpenCode, and friends — from your Mac. This takes about a
                minute: check your tools, connect a project, and you&apos;re
                off.
              </p>
            </div>
          ) : null}

          {step === STEP_INDEX.appearance ? (
            <div className="space-y-5">
              <div className="text-center">
                <h2
                  id="onboarding-title"
                  className="text-[length:var(--fd-text-xl)] font-semibold text-fg-primary"
                >
                  Choose your appearance
                </h2>
                <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-muted">
                  Pick how FalconDeck looks. Changes apply immediately and can
                  be adjusted later in Settings → Appearance.
                </p>
              </div>
              <div className="mx-auto w-full max-w-lg rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 p-4">
                <ThemeControls />
              </div>
            </div>
          ) : null}

          {step === STEP_INDEX.dictation ? (
            <div className="space-y-4">
              <div className="text-center">
                <h2
                  id="onboarding-title"
                  className="text-[length:var(--fd-text-xl)] font-semibold text-fg-primary"
                >
                  Dictate anywhere on your Mac
                </h2>
                <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-muted">
                  Apple Speech works without an API key. You can optionally use
                  an OpenRouter transcription model instead.
                </p>
              </div>
              <DictationSetup
                baseUrl={baseUrl}
                onToast={onToast}
                compact
              />
            </div>
          ) : null}

          {step === STEP_INDEX.tools ? (
            <div className="space-y-4">
              <div className="text-center">
                <h2
                  id="onboarding-title"
                  className="text-[length:var(--fd-text-xl)] font-semibold text-fg-primary"
                >
                  Check your tools
                </h2>
                <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-muted">
                  FalconDeck doesn&apos;t ship coding CLIs. Install at least one
                  to start talking to an agent.
                </p>
              </div>
              {loadError ? (
                <div className="flex items-center justify-center gap-3 px-2 py-6">
                  <p className="text-[length:var(--fd-text-sm)] text-danger">
                    {loadError}
                  </p>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => void probeHarnesses()}
                  >
                    Retry
                  </Button>
                </div>
              ) : !overview ? (
                <div className="flex items-center justify-center gap-2 px-2 py-10 text-[length:var(--fd-text-sm)] text-fg-muted">
                  <ActivityDiamond size="md" />
                  Checking what&apos;s installed…
                </div>
              ) : (
                <div className="space-y-2">
                  {overview.harnesses.map((harness) => {
                    const status = harnessStatus(harness);
                    const jobForThis = activeJob?.harnessId === harness.id;
                    return (
                      <div
                        key={harness.id}
                        className="rounded-[var(--fd-radius-lg)] border border-border-subtle px-4 py-3"
                      >
                        <div className="flex items-center gap-3">
                          {harness.installed ? (
                            <CheckCircle2
                              aria-hidden="true"
                              className="h-4 w-4 shrink-0 text-success"
                            />
                          ) : (
                            <CircleDashed
                              aria-hidden="true"
                              className="h-4 w-4 shrink-0 text-fg-muted"
                            />
                          )}
                          <ProviderIcon
                            provider={harness.id}
                            className="h-4 w-4 text-fg-secondary"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                                {harness.label}
                              </span>
                              <Badge variant={status.variant}>
                                {status.label}
                              </Badge>
                              {harness.version ? (
                                <span className="font-mono text-[length:var(--fd-text-xs)] text-fg-muted">
                                  v{harness.version}
                                  {harness.latest_version && harness.update_available
                                    ? ` → ${harness.latest_version}`
                                    : ""}
                                </span>
                              ) : null}
                            </div>
                            {harness.account_status ? (
                              <p className="mt-0.5 truncate text-[length:var(--fd-text-xs)] text-fg-muted">
                                {harness.account_status}
                              </p>
                            ) : null}
                            {jobForThis ? (
                              <p className="mt-1 text-[length:var(--fd-text-xs)] text-fg-secondary">
                                <ActivityDiamond size="sm" tone="current" />{" "}
                                {activeJob?.action === "update" ? "Updating…" : "Installing…"}
                              </p>
                            ) : null}
                          </div>
                          {harness.upgrade_command ? (
                            <Button
                              size="sm"
                              variant={harness.installed ? "secondary" : "default"}
                              disabled={
                                !api || isProbing || activeJob != null
                              }
                              onClick={() => void startInstall(harness)}
                            >
                              {harness.installed &&
                              harness.update_available === true ? (
                                <Download className="h-4 w-4" />
                              ) : null}
                              {harness.installed ? "Update" : "Install"}
                            </Button>
                          ) : null}
                        </div>
                        {jobForThis && jobLog.length > 0 ? (
                          <pre className="mt-2 max-h-32 overflow-y-auto rounded-[var(--fd-radius-md)] bg-surface-2 p-2 font-mono text-[length:var(--fd-text-xs)] text-fg-secondary">
                            {jobLog.join("\n")}
                          </pre>
                        ) : null}
                      </div>
                    );
                  })}
                  <div className="flex justify-center pt-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={isProbing || activeJob != null}
                      onClick={() => void probeHarnesses()}
                    >
                      <RefreshCw className="h-4 w-4" />
                      Check again
                    </Button>
                  </div>
                  {installedCount === 0 ? (
                    <p className="pt-1 text-center text-[length:var(--fd-text-xs)] text-fg-muted">
                      Nothing installed yet? Continue to add a project anyway —
                      you can install a CLI any time in Settings → Harnesses.
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}

          {step === STEP_INDEX.project ? (
            <div className="space-y-4">
              <div className="text-center">
                <h2
                  id="onboarding-title"
                  className="text-[length:var(--fd-text-xl)] font-semibold text-fg-primary"
                >
                  {workspacesCount > 0
                    ? "Add another project"
                    : "Add your first project"}
                </h2>
                <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-muted">
                  Pick a folder you work in. FalconDeck connects its agent
                  sessions and history to it.
                </p>
              </div>
              <div className="flex flex-col items-center gap-3 py-4">
                {workspacesCount > 0 ? (
                  <p className="flex items-center gap-2 text-[length:var(--fd-text-sm)] text-fg-secondary">
                    <CheckCircle2
                      aria-hidden="true"
                      className="h-4 w-4 text-success"
                    />
                    {workspacesCount}{" "}
                    {workspacesCount === 1 ? "project" : "projects"} connected
                  </p>
                ) : null}
                <Button
                  variant="secondary"
                  disabled={isImportingSessions}
                  onClick={onAddProject}
                >
                  {isImportingSessions ? (
                    <ActivityDiamond size="md" tone="current" />
                  ) : (
                    <FolderPlus className="h-4 w-4" />
                  )}
                  {isImportingSessions ? "Importing sessions…" : "Choose a folder…"}
                </Button>
              </div>
            </div>
          ) : null}

          {step === STEP_INDEX.finish ? (
            <div className="space-y-4">
              <div className="text-center">
                <h2
                  id="onboarding-title"
                  className="text-[length:var(--fd-text-xl)] font-semibold text-fg-primary"
                >
                  You&apos;re set
                </h2>
                <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-muted">
                  FalconDeck can notify you when an agent finishes or needs your
                  decision.
                </p>
              </div>
              <div className="flex flex-col items-center gap-3 py-2">
                {notificationPermission === "granted" ? (
                  <p className="flex items-center gap-2 text-[length:var(--fd-text-sm)] text-fg-secondary">
                    <CheckCircle2
                      aria-hidden="true"
                      className="h-4 w-4 text-success"
                    />
                    Notifications enabled
                  </p>
                ) : notificationPermission === "unsupported" ? (
                  <p className="text-[length:var(--fd-text-sm)] text-fg-muted">
                    Notifications are unavailable on this system; you can skip
                    this.
                  </p>
                ) : (
                  <Button
                    variant="secondary"
                    disabled={isRequestingPermission}
                    onClick={() => void requestNotifications()}
                  >
                    {isRequestingPermission ? (
                      <ActivityDiamond size="md" tone="current" />
                    ) : null}
                    Enable notifications
                  </Button>
                )}
                {notificationPermission === "denied" ? (
                  <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
                    Denied — you can re-enable FalconDeck in System Settings →
                    Notifications.
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border-subtle px-6 py-4">
          <div>
            {step > 0 ? (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep((current) => current - 1)}
              >
                Back
              </Button>
            ) : null}
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onComplete(true)}>
              Skip setup
            </Button>
            {isLastStep ? (
              <Button
                ref={nextRef}
                type="button"
                onClick={() => onComplete(false)}
              >
                Start using FalconDeck
              </Button>
            ) : (
              <Button
                ref={nextRef}
                type="button"
                onClick={() => setStep((current) => current + 1)}
              >
                Continue
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

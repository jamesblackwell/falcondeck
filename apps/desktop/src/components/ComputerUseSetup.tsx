import { useCallback, useEffect, useRef, useState } from "react";

import { createDaemonApiClient } from "@falcondeck/client-core";
import type { ComputerUseStatus, ComputerUseTestResult } from "@falcondeck/client-core";
import {
  ActivityDiamond,
  Badge,
  Button,
  SettingList,
  SettingRow,
  SettingsSection,
} from "@falcondeck/ui";
import { ExternalLink, RefreshCw } from "lucide-react";

import {
  openComputerUseSettings,
  readComputerUsePermissions,
  requestComputerUsePermission,
  restartFalconDeck,
  type ComputerUsePermission,
  type ComputerUsePermissionStatus,
} from "../computer-use";
import { isTauriDesktop } from "../api";

export type ComputerUseSetupToast = {
  variant: "success" | "danger" | "warning" | "default";
  title: string;
  description?: string;
};

type ComputerUseSetupProps = {
  baseUrl: string | null;
  onToast: (toast: ComputerUseSetupToast) => void;
  compact?: boolean;
  onStatusChange?: (status: ComputerUseStatus | null) => void;
  onPermissionsChange?: (permissions: ComputerUsePermissionStatus) => void;
  /** Sync work that must land before `restart_app` kills the process. */
  onBeforeAppRestart?: () => void;
};

const PERMISSION_COPY: Record<
  ComputerUsePermission,
  { title: string; description: string }
> = {
  accessibility: {
    title: "Accessibility",
    description: "Lets agents click, type, and read other apps without stealing focus.",
  },
  screen_recording: {
    title: "Screen Recording",
    description: "Lets agents see window contents. macOS lists this as Screen & System Audio Recording.",
  },
};

export function ComputerUseSetup({
  baseUrl,
  onToast,
  compact = false,
  onStatusChange,
  onPermissionsChange,
  onBeforeAppRestart,
}: ComputerUseSetupProps) {
  const [permissions, setPermissions] = useState<ComputerUsePermissionStatus | null>(null);
  const [status, setStatus] = useState<ComputerUseStatus | null>(null);
  const [test, setTest] = useState<ComputerUseTestResult | null>(null);
  const [busy, setBusy] = useState<"grant" | "test" | "restart" | "app-restart" | null>(
    null,
  );

  const refreshPermissions = useCallback(async () => {
    const next = await readComputerUsePermissions();
    setPermissions(next);
    onPermissionsChange?.(next);
  }, [onPermissionsChange]);

  const refreshStatus = useCallback(async () => {
    if (!baseUrl) {
      setStatus(null);
      onStatusChange?.(null);
      return;
    }
    try {
      const next = await createDaemonApiClient(baseUrl).computerUse();
      setStatus(next);
      onStatusChange?.(next);
    } catch {
      setStatus(null);
      onStatusChange?.(null);
    }
  }, [baseUrl, onStatusChange]);

  useEffect(() => {
    void refreshPermissions();
    void refreshStatus();
  }, [refreshPermissions, refreshStatus]);

  useEffect(() => {
    const onFocus = () => {
      void refreshPermissions();
      void refreshStatus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refreshPermissions, refreshStatus]);

  const seenGrants = useRef<{ ready: boolean; both: boolean }>({
    ready: false,
    both: false,
  });
  useEffect(() => {
    if (!permissions) return;
    const both = permissions.accessibility && permissions.screenRecording;
    if (!seenGrants.current.ready) {
      seenGrants.current = { ready: true, both };
      return;
    }
    if (both === seenGrants.current.both) return;
    seenGrants.current.both = both;
    if (!both || !baseUrl || !status?.enabled) return;
    void createDaemonApiClient(baseUrl)
      .restartComputerUse()
      .then((next) => {
        setStatus(next);
        onStatusChange?.(next);
      })
      .catch(() => {});
  }, [baseUrl, onStatusChange, permissions, status?.enabled]);

  const grant = async (permission: ComputerUsePermission) => {
    setBusy("grant");
    try {
      await requestComputerUsePermission(permission);
      window.setTimeout(() => void refreshPermissions(), 600);
      window.setTimeout(() => {
        void refreshPermissions();
        void refreshStatus();
      }, 1800);
    } finally {
      setBusy(null);
    }
  };

  const openSettings = async (permission: ComputerUsePermission) => {
    await openComputerUseSettings(permission);
    window.setTimeout(() => void refreshPermissions(), 1800);
  };

  const runTest = async () => {
    if (!baseUrl) return;
    setBusy("test");
    setTest(null);
    try {
      const result = await createDaemonApiClient(baseUrl).testComputerUse();
      setTest(result);
      await refreshStatus();
      if (result.ok) {
        onToast({
          variant: "success",
          title: "Computer use is working",
          description: "FalconDeck captured a window without stealing focus.",
        });
      } else if (result.black_frame) {
        onToast({
          variant: "warning",
          title: "Screen Recording looks granted but the capture is blank",
          description: "Restart FalconDeck so macOS re-evaluates the grant.",
        });
      } else {
        onToast({
          variant: "danger",
          title: "Could not test computer use",
          description: result.error ?? "Grant both permissions, then try again.",
        });
      }
    } catch (error) {
      onToast({
        variant: "danger",
        title: "Could not test computer use",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };

  const restartDriver = async () => {
    if (!baseUrl) return;
    setBusy("restart");
    try {
      await createDaemonApiClient(baseUrl).restartComputerUse();
      await refreshStatus();
      onToast({ variant: "success", title: "Computer-use driver restarted" });
    } catch (error) {
      onToast({
        variant: "danger",
        title: "Could not restart the driver",
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };

  const restartApp = async () => {
    onBeforeAppRestart?.();
    setBusy("app-restart");
    try {
      await restartFalconDeck();
    } catch (error) {
      onToast({
        variant: "danger",
        title: "Could not restart FalconDeck",
        description: error instanceof Error ? error.message : String(error),
      });
      setBusy(null);
    }
  };

  const supported = permissions?.supported !== false && isTauriDesktop();
  const macosOk = permissions?.macosOk ?? status?.macos_ok ?? true;
  const accessibility = permissions?.accessibility ?? status?.permissions.accessibility ?? false;
  const screenRecording =
    permissions?.screenRecording ?? status?.permissions.screen_recording ?? false;

  if (!supported) {
    return (
      <p className="text-[length:var(--fd-text-sm)] text-fg-muted">
        Computer use is available in the FalconDeck Mac app on macOS 14 or later.
      </p>
    );
  }

  if (!macosOk) {
    return (
      <p className="text-[length:var(--fd-text-sm)] text-fg-muted">
        Computer use needs macOS 14 or later. This Mac is on macOS{" "}
        {permissions?.macosMajor ?? "13 or older"}.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <SettingsSection
        title="Permissions"
        description="Grant both to FalconDeck. Agents inherit them — you will not see a second app in System Settings."
      >
        <SettingList>
          {(["accessibility", "screen_recording"] as const).map((permission) => {
            const granted = permission === "accessibility" ? accessibility : screenRecording;
            const copy = PERMISSION_COPY[permission];
            return (
              <SettingRow
                key={permission}
                title={copy.title}
                description={copy.description}
                control={
                  <div className="flex items-center gap-2">
                    <Badge variant={granted ? "success" : "warning"}>
                      {granted ? "Granted" : "Needed"}
                    </Badge>
                    {granted ? null : (
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={busy === "grant"}
                        onClick={() => void grant(permission)}
                      >
                        Grant
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void openSettings(permission)}
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      Settings
                    </Button>
                  </div>
                }
              />
            );
          })}
        </SettingList>
      </SettingsSection>

      {compact ? null : (
        <SettingsSection
          title="Driver"
          description={
            status?.driver_version
              ? `Bundled cua-driver ${status.driver_version}`
              : "The driver starts the first time an agent needs it."
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy === "test" || !baseUrl || !status?.enabled}
              title={status?.enabled ? undefined : "Turn on computer use before testing it."}
              onClick={() => void runTest()}
            >
              {busy === "test" ? <ActivityDiamond size="md" tone="current" /> : null}
              Test it
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy === "restart" || !baseUrl}
              onClick={() => void restartDriver()}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Restart driver
            </Button>
            {test?.black_frame ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy === "app-restart"}
                onClick={() => void restartApp()}
              >
                Restart FalconDeck
              </Button>
            ) : null}
          </div>
          {test?.thumbnail_data_url ? (
            <img
              src={test.thumbnail_data_url}
              alt="Test capture of FalconDeck"
              className="mt-3 max-h-40 rounded-[var(--fd-radius-md)] border border-border-subtle"
            />
          ) : null}
          {status?.last_error ? (
            <p className="text-[length:var(--fd-text-xs)] text-danger">{status.last_error}</p>
          ) : null}
        </SettingsSection>
      )}

      {compact ? (
        <div className="space-y-2">
          <div className="flex flex-wrap justify-center gap-2">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy === "test" || !baseUrl || !status?.enabled}
              title={status?.enabled ? undefined : "Turn on computer use before testing it."}
              onClick={() => void runTest()}
            >
              {busy === "test" ? <ActivityDiamond size="md" tone="current" /> : null}
              Test it
            </Button>
            {isTauriDesktop() ? (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy === "app-restart"}
                onClick={() => void restartApp()}
              >
                {busy === "app-restart" ? (
                  <ActivityDiamond size="md" tone="current" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Restart FalconDeck
              </Button>
            ) : null}
          </div>
          {isTauriDesktop() ? (
            <p className="text-center text-[length:var(--fd-text-xs)] text-fg-muted">
              macOS applies new Accessibility and Screen Recording grants after
              FalconDeck restarts. Setup continues on this step.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

import { memo } from "react";
import { Activity, Clock3, Settings } from "lucide-react";

import {
  ExtensionPanelNavigation,
  WorkspaceSidebar,
  type WorkspaceSidebarProps,
} from "@falcondeck/chat-ui";
import type { ExtensionPanelDefinition } from "@falcondeck/client-core";
import { cn } from "@falcondeck/ui";

import { shortcutHint, shortcutTitle, useShortcutSettings } from "../shortcuts";

export type DesktopSidebarProps = WorkspaceSidebarProps & {
  onOpenSettings?: () => void;
  settingsOpen?: boolean;
  onOpenScheduled?: () => void;
  scheduledOpen?: boolean;
  scheduledAttention?: boolean;
  onOpenActivity?: () => void;
  activityOpen?: boolean;
  activityCount?: number;
  activityHasFailure?: boolean;
  extensionPanels?: readonly ExtensionPanelDefinition[];
  activeExtensionPanelKey?: string | null;
  onOpenExtensionPanel?: (panelKey: string) => void;
};

export const DesktopSidebar = memo(function DesktopSidebar({
  onOpenSettings,
  settingsOpen = false,
  onOpenScheduled,
  scheduledOpen = false,
  scheduledAttention = false,
  onOpenActivity,
  activityOpen = false,
  activityCount = 0,
  activityHasFailure = false,
  extensionPanels = [],
  activeExtensionPanelKey = null,
  onOpenExtensionPanel,
  ...props
}: DesktopSidebarProps) {
  const shortcutSettings = useShortcutSettings();
  return (
    <WorkspaceSidebar
      {...props}
      newThreadShortcut={shortcutHint("newThread", shortcutSettings) ?? undefined}
      addProjectShortcut={shortcutHint("openProject", shortcutSettings) ?? undefined}
      headerClassName="min-h-12 justify-center gap-1 pb-1 pl-20 pr-3 pt-1"
      topNavigation={
        onOpenScheduled || onOpenActivity || extensionPanels.length > 0 ? (
          <>
            {onOpenActivity ? (
              <button
                type="button"
                onClick={onOpenActivity}
                className={cn(
                  "fd-focus flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-3 py-2 text-left text-[length:var(--fd-text-sm)] transition-colors",
                  activityOpen
                    ? "bg-surface-3 text-fg-primary"
                    : "text-fg-secondary hover:bg-surface-3 hover:text-fg-primary",
                )}
                aria-current={activityOpen ? "page" : undefined}
                aria-label="Activity"
                title={shortcutTitle(
                  "Activity — attention queue across projects",
                  "openActivity",
                  shortcutSettings,
                )}
              >
                <Activity aria-hidden="true" className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">Activity</span>
                {activityCount > 0 ? (
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-0.5 text-[length:var(--fd-text-2xs)] font-semibold",
                      activityHasFailure
                        ? "bg-danger-muted text-danger"
                        : "bg-warning-muted text-warning",
                    )}
                  >
                    {activityCount}
                  </span>
                ) : null}
              </button>
            ) : null}
            {onOpenScheduled ? (
              <button
                type="button"
                onClick={onOpenScheduled}
                className={cn(
                  "fd-focus flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-3 py-2 text-left text-[length:var(--fd-text-sm)] transition-colors",
                  scheduledOpen
                    ? "bg-surface-3 text-fg-primary"
                    : "text-fg-secondary hover:bg-surface-3 hover:text-fg-primary",
                )}
                aria-current={scheduledOpen ? "page" : undefined}
                aria-label="Scheduled"
              >
                <Clock3 aria-hidden="true" className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">Scheduled</span>
                {scheduledAttention ? (
                  <span
                    aria-hidden="true"
                    title="Scheduled tasks need attention"
                    className="h-1.5 w-1.5 rounded-full bg-danger"
                  />
                ) : null}
              </button>
            ) : null}
            {onOpenExtensionPanel ? (
              <ExtensionPanelNavigation
                panels={extensionPanels}
                activePanelKey={activeExtensionPanelKey}
                onSelect={onOpenExtensionPanel}
              />
            ) : null}
          </>
        ) : null
      }
      footer={
        onOpenSettings ? (
          <button
            type="button"
            onClick={onOpenSettings}
            className={cn(
              "fd-focus flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-3 py-2 text-left text-[length:var(--fd-text-sm)] transition-colors",
              settingsOpen
                ? "bg-surface-3 text-fg-primary"
                : "text-fg-secondary hover:bg-surface-3 hover:text-fg-primary",
            )}
            aria-current={settingsOpen ? "page" : undefined}
            title={shortcutTitle("Settings", "openSettings", shortcutSettings)}
          >
            <Settings aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span>Settings</span>
          </button>
        ) : null
      }
    />
  );
});

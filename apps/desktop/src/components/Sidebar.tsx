import { memo } from "react";
import {
  Activity,
  Blocks,
  Clock3,
  PanelsTopLeft,
  Settings,
} from "lucide-react";

import {
  ExtensionPanelNavigation,
  WorkspaceSidebar,
  type WorkspaceSidebarProps,
} from "@falcondeck/chat-ui";
import type { ExtensionPanelDefinition } from "@falcondeck/client-core";
import { cn, Tooltip } from "@falcondeck/ui";

import { shortcutHintTokens, useShortcutSettings } from "../shortcuts";

export type DesktopSidebarProps = WorkspaceSidebarProps & {
  onOpenSettings?: () => void;
  settingsOpen?: boolean;
  onOpenScheduled?: () => void;
  scheduledOpen?: boolean;
  scheduledAttention?: boolean;
  onOpenActivity?: () => void;
  onPopOutActivity?: () => void;
  activityOpen?: boolean;
  activityCount?: number;
  activityHasFailure?: boolean;
  onOpenExtensions?: () => void;
  extensionsOpen?: boolean;
  enabledExtensionCount?: number;
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
  onPopOutActivity,
  activityOpen = false,
  activityCount = 0,
  activityHasFailure = false,
  onOpenExtensions,
  extensionsOpen = false,
  enabledExtensionCount = 0,
  extensionPanels = [],
  activeExtensionPanelKey = null,
  onOpenExtensionPanel,
  ...props
}: DesktopSidebarProps) {
  const shortcutSettings = useShortcutSettings();
  return (
    <WorkspaceSidebar
      {...props}
      newThreadShortcut={shortcutHintTokens("newThread", shortcutSettings)}
      addProjectShortcut={shortcutHintTokens(
        "openProject",
        shortcutSettings,
      )}
      searchShortcut={shortcutHintTokens(
        "commandPalette",
        shortcutSettings,
      )}
      headerClassName="h-12 justify-center gap-0 py-0 pl-20 pr-2"
      topNavigation={
        onOpenScheduled ||
        onOpenActivity ||
        onOpenExtensions ||
        extensionPanels.length > 0 ? (
          <>
            {onOpenActivity ? (
              // The detach action rides on the row rather than taking a line
              // of its own: it swaps in for the count on hover, the way a
              // native list reveals row actions.
              <div className="group relative">
                <Tooltip
                  label="Activity"
                  shortcut={shortcutHintTokens(
                    "openActivity",
                    shortcutSettings,
                  )}
                >
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
                        onPopOutActivity &&
                          "transition-opacity group-hover:opacity-0 group-focus-within:opacity-0",
                      )}
                    >
                      {activityCount}
                    </span>
                  ) : null}
                  </button>
                </Tooltip>
                {onPopOutActivity ? (
                  <Tooltip label="Open in a new window">
                    <button
                      type="button"
                      onClick={onPopOutActivity}
                      className="fd-focus absolute right-1.5 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-[var(--fd-radius-sm)] text-fg-muted opacity-0 transition-opacity hover:bg-surface-4 hover:text-fg-primary focus-visible:opacity-100 group-hover:opacity-100"
                      aria-label="Open Activity in a new window"
                    >
                      <PanelsTopLeft aria-hidden="true" className="h-3.5 w-3.5" />
                    </button>
                  </Tooltip>
                ) : null}
              </div>
            ) : null}
            {onOpenExtensions ? (
              <Tooltip label="Extensions">
                <button
                  type="button"
                  onClick={onOpenExtensions}
                  className={cn(
                    "fd-focus flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-3 py-2 text-left text-[length:var(--fd-text-sm)] transition-colors",
                    extensionsOpen
                      ? "bg-surface-3 text-fg-primary"
                      : "text-fg-secondary hover:bg-surface-3 hover:text-fg-primary",
                  )}
                  aria-current={extensionsOpen ? "page" : undefined}
                  aria-label="Extensions"
                >
                  <Blocks aria-hidden="true" className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1">Extensions</span>
                  {enabledExtensionCount > 0 ? (
                    <span className="text-[length:var(--fd-text-2xs)] tabular-nums text-fg-muted">
                      {enabledExtensionCount}
                    </span>
                  ) : null}
                </button>
              </Tooltip>
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
          <Tooltip
            label="Settings"
            shortcut={shortcutHintTokens("openSettings", shortcutSettings)}
          >
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
            >
              <Settings aria-hidden="true" className="h-4 w-4 shrink-0" />
              <span>Settings</span>
            </button>
          </Tooltip>
        ) : null
      }
    />
  );
});

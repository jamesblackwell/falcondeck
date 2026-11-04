import { memo } from "react";
import {
  Inbox,
  CalendarClock,
  Bell,
} from "lucide-react";

import {
  ExtensionPanelNavigation,
  WorkspaceSidebar,
  type WorkspaceSidebarProps,
} from "@falcondeck/chat-ui";
import type { ExtensionPanelDefinition } from "@falcondeck/client-core";
import { cn, Tooltip } from "@falcondeck/ui";
import { reviewBadgeLabel } from "../review-inbox";

import { shortcutHintTokens, useShortcutSettings } from "../shortcuts";
import { useSidebarLayout, type SidebarLayoutMode } from "../sidebar-layout";
import { SidebarOptionsMenu } from "./SidebarOptionsMenu";

export type DesktopSidebarProps = WorkspaceSidebarProps & {
  onOpenSettings?: () => void;
  settingsOpen?: boolean;
  onOpenAnalytics?: () => void
  onOpenUsage?: () => void;
  onOpenKeyboardShortcuts?: () => void;
  onOpenSpeechSettings?: () => void;
  onCheckForUpdates?: () => void;
  updateStatus?: 'available' | 'downloaded' | null;
  onOpenTickets?: () => void;
  ticketsOpen?: boolean;
  /** Absent on a daemon without the notification centre. */
  onOpenNotifications?: () => void;
  notificationsOpen?: boolean;
  unreadNotifications?: number;
  /** Present only when the review inbox is on; `reviewCount` is the open ones. */
  onOpenReviews?: () => void;
  reviewsOpen?: boolean;
  reviewCount?: number;
  onOpenScheduled?: () => void;
  scheduledOpen?: boolean;
  scheduledAttention?: boolean;
  onOpenExtensions?: () => void;
  extensionsOpen?: boolean;
  enabledExtensionCount?: number;
  onOpenPlugins?: () => void;
  pluginsOpen?: boolean;
  extensionPanels?: readonly ExtensionPanelDefinition[];
  activeExtensionPanelKey?: string | null;
  onOpenExtensionPanel?: (panelKey: string) => void;
};

export const DesktopSidebar = memo(function DesktopSidebar({
  onOpenSettings,
  settingsOpen = false,
  onOpenAnalytics,
  onOpenUsage,
  onOpenKeyboardShortcuts,
  onOpenSpeechSettings,
  onCheckForUpdates,
  updateStatus = null,
  onOpenTickets,
  ticketsOpen = false,
  onOpenNotifications,
  notificationsOpen = false,
  unreadNotifications = 0,
  onOpenReviews,
  reviewsOpen = false,
  reviewCount = 0,
  onOpenScheduled,
  scheduledOpen = false,
  scheduledAttention = false,
  onOpenExtensions,
  extensionsOpen = false,
  enabledExtensionCount = 0,
  onOpenPlugins,
  pluginsOpen = false,
  extensionPanels = [],
  activeExtensionPanelKey = null,
  onOpenExtensionPanel,
  layoutMode: layoutModeProp,
  onLayoutModeChange,
  ...props
}: DesktopSidebarProps & {
  onLayoutModeChange?: (mode: SidebarLayoutMode) => void;
}) {
  const shortcutSettings = useShortcutSettings();
  const [localLayoutMode, setLocalLayoutMode] = useSidebarLayout();
  const layoutMode = layoutModeProp ?? localLayoutMode;
  const handleLayoutModeChange = onLayoutModeChange ?? setLocalLayoutMode;
  return (
    <WorkspaceSidebar
      {...props}
      layoutMode={layoutMode}
      newThreadShortcut={shortcutHintTokens(
        props.onNewChat ? "newChat" : "newThread",
        shortcutSettings,
      )}
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
        onOpenNotifications ||
        onOpenReviews ||
        onOpenScheduled ||
        extensionPanels.length > 0 ? (
          <>
            {onOpenNotifications ? (
              <button type="button" onClick={onOpenNotifications} aria-current={notificationsOpen ? "page" : undefined}
                aria-label={unreadNotifications > 0 ? `Notifications, ${unreadNotifications} unread` : "Notifications"}
                className={cn("fd-focus flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-3 py-2 text-left text-[length:var(--fd-text-sm)] transition-colors", notificationsOpen ? "bg-surface-3 text-fg-primary" : "text-fg-secondary hover:bg-surface-3 hover:text-fg-primary")}>
                <Bell aria-hidden="true" className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">Notifications</span>
                {reviewBadgeLabel(unreadNotifications) ? (
                  <span aria-hidden="true" className="rounded-full bg-accent-muted px-1.5 py-0.5 text-[length:var(--fd-text-2xs)] font-semibold tabular-nums text-accent">
                    {reviewBadgeLabel(unreadNotifications)}
                  </span>
                ) : null}
              </button>
            ) : null}
            {onOpenReviews ? (
              <button type="button" onClick={onOpenReviews} aria-current={reviewsOpen ? "page" : undefined}
                aria-label={reviewCount > 0 ? `Reviews, ${reviewCount} open` : "Reviews"}
                className={cn("fd-focus flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-3 py-2 text-left text-[length:var(--fd-text-sm)] transition-colors", reviewsOpen ? "bg-surface-3 text-fg-primary" : "text-fg-secondary hover:bg-surface-3 hover:text-fg-primary")}>
                <Inbox aria-hidden="true" className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">Reviews</span>
                {reviewBadgeLabel(reviewCount) ? (
                  <span aria-hidden="true" className="rounded-full bg-warning-muted px-1.5 py-0.5 text-[length:var(--fd-text-2xs)] font-semibold tabular-nums text-warning">
                    {reviewBadgeLabel(reviewCount)}
                  </span>
                ) : null}
              </button>
            ) : null}
            {onOpenScheduled ? (
              <Tooltip label="Automations">
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
                  aria-label="Automations"
                >
                  <CalendarClock aria-hidden="true" className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1">Automations</span>
                  {scheduledAttention ? (
                    <span
                      aria-hidden="true"
                      title="An automation needs attention"
                      className="h-1.5 w-1.5 rounded-full bg-danger"
                    />
                  ) : null}
                </button>
              </Tooltip>
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
        <SidebarOptionsMenu
          onOpenSettings={onOpenSettings}
          settingsOpen={settingsOpen}
          onOpenAnalytics={onOpenAnalytics}
          onOpenUsage={onOpenUsage}
          onOpenKeyboardShortcuts={onOpenKeyboardShortcuts}
          onOpenSpeechSettings={onOpenSpeechSettings}
          onCheckForUpdates={onCheckForUpdates}
          updateStatus={updateStatus}
          layoutMode={layoutMode}
          onLayoutModeChange={handleLayoutModeChange}
          onOpenExtensions={onOpenExtensions}
          extensionsOpen={extensionsOpen}
          enabledExtensionCount={enabledExtensionCount}
          onOpenPlugins={onOpenPlugins}
          pluginsOpen={pluginsOpen}
          onOpenTickets={onOpenTickets}
          ticketsOpen={ticketsOpen}
        />
      }
    />
  );
});

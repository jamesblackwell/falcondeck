import { memo } from 'react'
import { Activity, Settings } from 'lucide-react'

import {
  WorkspaceSidebar,
  type WorkspaceSidebarProps,
} from '@falcondeck/chat-ui'
import { cn } from '@falcondeck/ui'

export type DesktopSidebarProps = WorkspaceSidebarProps & {
  onOpenSettings?: () => void
  settingsOpen?: boolean
  onOpenActivity?: () => void
  activityOpen?: boolean
  activityCount?: number
  activityHasFailure?: boolean
}

export const DesktopSidebar = memo(function DesktopSidebar({
  onOpenSettings,
  settingsOpen = false,
  onOpenActivity,
  activityOpen = false,
  activityCount = 0,
  activityHasFailure = false,
  ...props
}: DesktopSidebarProps) {
  return (
    <WorkspaceSidebar
      {...props}
      headerClassName="min-h-12 justify-center gap-1 pb-1 pl-20 pr-3 pt-1"
      topNavigation={onOpenActivity ? (
        <button
          type="button"
          onClick={onOpenActivity}
          className={cn(
            'fd-focus flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-3 py-2 text-left text-[length:var(--fd-text-sm)] transition-colors',
            activityOpen
              ? 'bg-surface-3 text-fg-primary'
              : 'text-fg-secondary hover:bg-surface-3 hover:text-fg-primary',
          )}
          aria-current={activityOpen ? 'page' : undefined}
          aria-label="Activity"
        >
          <Activity aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1">Activity</span>
          {activityCount > 0 ? (
            <span className={cn(
              'rounded-full px-1.5 py-0.5 text-[length:var(--fd-text-2xs)] font-semibold',
              activityHasFailure ? 'bg-danger-muted text-danger' : 'bg-warning-muted text-warning',
            )}>{activityCount}</span>
          ) : null}
        </button>
      ) : null}
      footer={
        onOpenSettings ? (
          <button
            type="button"
            onClick={onOpenSettings}
            className={cn(
              'fd-focus flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-3 py-2 text-left text-[length:var(--fd-text-sm)] transition-colors',
              settingsOpen
                ? 'bg-surface-3 text-fg-primary'
                : 'text-fg-secondary hover:bg-surface-3 hover:text-fg-primary',
            )}
            aria-current={settingsOpen ? 'page' : undefined}
          >
            <Settings aria-hidden="true" className="h-4 w-4 shrink-0" />
            <span>Settings</span>
          </button>
        ) : null
      }
    />
  )
})

import { memo } from 'react'
import { Settings } from 'lucide-react'

import {
  WorkspaceSidebar,
  type WorkspaceSidebarProps,
} from '@falcondeck/chat-ui'
import { cn } from '@falcondeck/ui'

export type DesktopSidebarProps = WorkspaceSidebarProps & {
  onOpenSettings?: () => void
  settingsOpen?: boolean
}

export const DesktopSidebar = memo(function DesktopSidebar({
  onOpenSettings,
  settingsOpen = false,
  ...props
}: DesktopSidebarProps) {
  return (
    <WorkspaceSidebar
      {...props}
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

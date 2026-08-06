import { PanelLeft, PanelRight } from 'lucide-react'

import { Button, cn } from '@falcondeck/ui'

type PanelTogglesProps = {
  sidebarVisible: boolean
  railVisible: boolean
  onToggleSidebar: () => void
  onToggleRail: () => void
}

export function PanelToggles({
  sidebarVisible,
  railVisible,
  onToggleSidebar,
  onToggleRail,
}: PanelTogglesProps) {
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onToggleSidebar}
        title="Toggle sidebar (⌘B)"
        aria-label="Toggle sidebar"
        aria-pressed={sidebarVisible}
        className={cn(!sidebarVisible && 'text-fg-muted')}
      >
        <PanelLeft className="h-4 w-4" />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onToggleRail}
        title="Toggle side panel (⌥⌘B)"
        aria-label="Toggle side panel"
        aria-pressed={railVisible}
        className={cn(!railVisible && 'text-fg-muted')}
      >
        <PanelRight className="h-4 w-4" />
      </Button>
    </div>
  )
}

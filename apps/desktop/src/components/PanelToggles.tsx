import { PanelLeft, PanelRight } from 'lucide-react'

import { Button, cn } from '@falcondeck/ui'

import { shortcutTitle, useShortcutSettings } from '../shortcuts'

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
  const shortcutSettings = useShortcutSettings()

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onToggleSidebar}
        title={shortcutTitle('Toggle sidebar', 'toggleSidebar', shortcutSettings)}
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
        title={shortcutTitle('Toggle side panel', 'toggleChanges', shortcutSettings)}
        aria-label="Toggle side panel"
        aria-pressed={railVisible}
        className={cn(!railVisible && 'text-fg-muted')}
      >
        <PanelRight className="h-4 w-4" />
      </Button>
    </div>
  )
}

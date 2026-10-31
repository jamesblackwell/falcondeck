import { PanelLeft, PanelRight } from 'lucide-react'

import { Button, Tooltip, cn } from '@falcondeck/ui'

import { shortcutHintTokens, useShortcutSettings } from '../shortcuts'

type PanelTogglesProps = {
  sidebarVisible: boolean
  railVisible: boolean
  showRailToggle?: boolean
  onToggleSidebar: () => void
  onToggleRail: () => void
}

export function PanelToggles({
  sidebarVisible,
  railVisible,
  showRailToggle = true,
  onToggleSidebar,
  onToggleRail,
}: PanelTogglesProps) {
  const shortcutSettings = useShortcutSettings()

  return (
    <div className="flex items-center gap-1">
      <Tooltip
        label="Toggle sidebar"
        shortcut={shortcutHintTokens('toggleSidebar', shortcutSettings)}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onToggleSidebar}
          aria-label="Toggle sidebar"
          aria-pressed={sidebarVisible}
          className={cn(!sidebarVisible && 'text-fg-muted')}
        >
          <PanelLeft className="h-4 w-4" />
        </Button>
      </Tooltip>
      {showRailToggle ? <Tooltip
        label="Toggle side panel"
        shortcut={shortcutHintTokens('toggleChanges', shortcutSettings)}
      >
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onToggleRail}
          aria-label="Toggle side panel"
          aria-pressed={railVisible}
          className={cn(!railVisible && 'text-fg-muted')}
        >
          <PanelRight className="h-4 w-4" />
        </Button>
      </Tooltip> : null}
    </div>
  )
}

import { PanelLeft, PanelRight } from 'lucide-react'

import { Button, cn } from '@falcondeck/ui'

import { bindingsFor, shortcutTokens, useShortcutSettings } from '../shortcuts'

type PanelTogglesProps = {
  sidebarVisible: boolean
  railVisible: boolean
  onToggleSidebar: () => void
  onToggleRail: () => void
}

function shortcutSuffix(shortcut: string | undefined) {
  return shortcut ? ` (${shortcutTokens(shortcut).join('')})` : ''
}

export function PanelToggles({
  sidebarVisible,
  railVisible,
  onToggleSidebar,
  onToggleRail,
}: PanelTogglesProps) {
  const shortcutSettings = useShortcutSettings()
  const sidebarShortcut = bindingsFor('toggleSidebar', shortcutSettings)[0]
  const changesShortcut = bindingsFor('toggleChanges', shortcutSettings)[0]

  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={onToggleSidebar}
        title={`Toggle sidebar${shortcutSuffix(sidebarShortcut)}`}
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
        title={`Toggle side panel${shortcutSuffix(changesShortcut)}`}
        aria-label="Toggle side panel"
        aria-pressed={railVisible}
        className={cn(!railVisible && 'text-fg-muted')}
      >
        <PanelRight className="h-4 w-4" />
      </Button>
    </div>
  )
}

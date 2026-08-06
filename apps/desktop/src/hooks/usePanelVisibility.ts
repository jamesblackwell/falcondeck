import { useCallback, useEffect, useState } from 'react'

const PANEL_VISIBILITY_STORAGE_KEY = 'falcondeck.desktop.panels.v1'

type PanelVisibility = {
  sidebar: boolean
  rail: boolean
}

const DEFAULT_VISIBILITY: PanelVisibility = { sidebar: true, rail: false }

function readPersistedVisibility(): PanelVisibility {
  if (typeof window === 'undefined') return DEFAULT_VISIBILITY
  try {
    const raw = window.localStorage.getItem(PANEL_VISIBILITY_STORAGE_KEY)
    if (!raw) return DEFAULT_VISIBILITY
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_VISIBILITY
    const record = parsed as Partial<Record<keyof PanelVisibility, unknown>>
    return {
      sidebar: typeof record.sidebar === 'boolean' ? record.sidebar : DEFAULT_VISIBILITY.sidebar,
      rail: typeof record.rail === 'boolean' ? record.rail : DEFAULT_VISIBILITY.rail,
    }
  } catch {
    return DEFAULT_VISIBILITY
  }
}

/**
 * Visibility state for the collapsible side panels, persisted across launches.
 * ⌘B toggles the sidebar; ⌥⌘B toggles the right side panel.
 */
export function usePanelVisibility() {
  const [visibility, setVisibility] = useState<PanelVisibility>(readPersistedVisibility)

  useEffect(() => {
    try {
      window.localStorage.setItem(PANEL_VISIBILITY_STORAGE_KEY, JSON.stringify(visibility))
    } catch {
      // Persistence is best-effort; ignore storage failures (private mode, quota).
    }
  }, [visibility])

  const toggleSidebar = useCallback(() => {
    setVisibility((current) => ({ ...current, sidebar: !current.sidebar }))
  }, [])

  const toggleRail = useCallback(() => {
    setVisibility((current) => ({ ...current, rail: !current.rail }))
  }, [])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!event.metaKey || event.ctrlKey || event.key.toLowerCase() !== 'b') return
      event.preventDefault()
      if (event.altKey) {
        toggleRail()
      } else {
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [toggleRail, toggleSidebar])

  return {
    sidebarVisible: visibility.sidebar,
    railVisible: visibility.rail,
    toggleSidebar,
    toggleRail,
  }
}

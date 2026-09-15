import type { TerminalSessionInfo } from '@falcondeck/client-core'

export type TerminalTabStatus = 'running' | 'exited'

export interface TerminalTab {
  session: TerminalSessionInfo
  status: TerminalTabStatus
  /** Runtime title observed from the running program (OSC), if any. */
  observedTitle: string | null
}

export function terminalTabLabel(tab: TerminalTab): string {
  return tab.observedTitle ?? tab.session.title
}

export function nextActiveTabId(tabs: TerminalTab[], removedId: string): string | null {
  const removedIndex = tabs.findIndex((tab) => tab.session.id === removedId)
  if (removedIndex === -1) return tabs.at(-1)?.session.id ?? null
  const remaining = tabs.filter((tab) => tab.session.id !== removedId)
  if (remaining.length === 0) return null
  return (remaining[removedIndex] ?? remaining.at(-1)).session.id
}

export function adjacentTabId(
  tabs: TerminalTab[],
  activeId: string | null,
  offset: -1 | 1,
): string | null {
  if (tabs.length === 0) return null
  const currentIndex = tabs.findIndex((tab) => tab.session.id === activeId)
  const start = currentIndex === -1 ? (offset === 1 ? -1 : 0) : currentIndex
  const next = tabs[(start + offset + tabs.length) % tabs.length]
  return next?.session.id ?? null
}

/**
 * Index of the tab addressed by ⌘1–⌘9 (⌘9 is always the last tab, as in
 * browsers and Terminal.app), or null when the event is not a tab jump.
 */
export function tabIndexForKeyEvent(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  tabCount: number,
): number | null {
  if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return null
  if (!/^[1-9]$/.test(event.key)) return null
  if (tabCount === 0) return null
  const digit = Number(event.key)
  if (digit === 9) return tabCount - 1
  return digit <= tabCount ? digit - 1 : null
}

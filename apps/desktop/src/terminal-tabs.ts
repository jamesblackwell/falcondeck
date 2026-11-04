import type { TerminalSessionInfo } from '@falcondeck/client-core'

import type { PaneNode } from './terminal-layout'

export type TerminalTabStatus = 'running' | 'exited'

/** One shell: a leaf of a tab's split layout. */
export interface TerminalPaneState {
  session: TerminalSessionInfo
  status: TerminalTabStatus
  /** Runtime title observed from the running program (OSC), if any. */
  observedTitle: string | null
  /** Foreground process reported by the daemon (`vim`, `zsh`). */
  process: string | null
  /** Foreground process working directory reported by the daemon. */
  cwd: string | null
}

export interface TerminalTab {
  id: string
  root: PaneNode
  focusedPaneId: string
  /** Name the user gave the tab; wins over every automatic title. */
  customTitle: string | null
}

export function newPane(session: TerminalSessionInfo): TerminalPaneState {
  return { session, status: 'running', observedTitle: null, process: null, cwd: null }
}

export function newTab(session: TerminalSessionInfo): TerminalTab {
  return {
    id: `tab-${session.id}`,
    root: { type: 'pane', id: session.id },
    focusedPaneId: session.id,
    customTitle: null,
  }
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  if (!trimmed) return '/'
  return trimmed.split('/').at(-1) ?? trimmed
}

function commandName(name: string): string {
  return basename(name.replace(/^-/, ''))
}

/**
 * A busy pane shows its program (its own OSC title when it set one, else the
 * process name); an idle shell shows its directory.
 */
export function terminalPaneLabel(pane: TerminalPaneState): string {
  const shell = commandName(pane.session.shell || pane.session.title)
  const process = pane.process ? commandName(pane.process) : null
  if (process && process !== shell) return pane.observedTitle ?? process
  if (!process && pane.observedTitle) return pane.observedTitle
  const cwd = pane.cwd ?? pane.session.cwd
  return cwd ? basename(cwd) : pane.session.title
}

export function terminalTabLabel(
  tab: TerminalTab,
  panes: Readonly<Record<string, TerminalPaneState>>,
): string {
  if (tab.customTitle) return tab.customTitle
  const pane = panes[tab.focusedPaneId]
  return pane ? terminalPaneLabel(pane) : 'Terminal'
}

export function nextActiveTabId(tabs: TerminalTab[], removedId: string): string | null {
  const removedIndex = tabs.findIndex((tab) => tab.id === removedId)
  if (removedIndex === -1) return tabs.at(-1)?.id ?? null
  const remaining = tabs.filter((tab) => tab.id !== removedId)
  if (remaining.length === 0) return null
  return (remaining[removedIndex] ?? remaining.at(-1))?.id ?? null
}

export function adjacentTabId(
  tabs: TerminalTab[],
  activeId: string | null,
  offset: -1 | 1,
): string | null {
  if (tabs.length === 0) return null
  const currentIndex = tabs.findIndex((tab) => tab.id === activeId)
  const start = currentIndex === -1 ? (offset === 1 ? -1 : 0) : currentIndex
  const next = tabs[(start + offset + tabs.length) % tabs.length]
  return next?.id ?? null
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

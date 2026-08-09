import * as React from 'react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  FolderClosed,
  MessageSquare,
  Monitor,
  Moon,
  Palette,
  Search,
  Settings,
  SquarePen,
  Sun,
} from 'lucide-react'

import type { ProjectGroup } from '@falcondeck/client-core'
import {
  Kbd,
  PALETTE_OPTIONS,
  cn,
  updateAppearance,
  useAppearance,
} from '@falcondeck/ui'


type PaletteItem = {
  id: string
  section: 'Threads' | 'Actions' | 'Appearance'
  label: string
  sublabel?: string
  icon: React.ReactNode
  keywords: string
  active?: boolean
  run: () => void
}

/**
 * Subsequence fuzzy score: lower is better, null means no match.
 * Substring hits rank above scattered subsequences; earlier hits rank higher.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (!q) return 0
  const index = t.indexOf(q)
  if (index >= 0) return index
  let ti = 0
  let gaps = 0
  for (const char of q) {
    const found = t.indexOf(char, ti)
    if (found === -1) return null
    gaps += found - ti
    ti = found + 1
  }
  return 1000 + gaps
}

export type CommandPaletteProps = {
  groups: ProjectGroup[]
  onSelectThread: (workspaceId: string, threadId: string) => void
  onNewThread?: (workspaceId: string) => void
  onOpenSettings?: () => void
  /** Controlled open request for hosts with customizable shortcuts. */
  openRequestKey?: number
  initialQuery?: string
  requestMode?: 'open' | 'toggle' | 'close'
}

/**
 * Cmd/Ctrl+K palette: fuzzy-jump to any thread, start a thread in a project,
 * or flip appearance settings. Self-contained — mount once per app.
 */
export const CommandPalette = memo(function CommandPalette({
  groups,
  onSelectThread,
  onNewThread,
  onOpenSettings,
  openRequestKey,
  initialQuery = '',
  requestMode = 'open',
}: CommandPaletteProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)
  const appearance = useAppearance()

  useEffect(() => {
    if (openRequestKey === undefined) return
    if (openRequestKey > 0) {
      setQuery(initialQuery)
      setOpen((current) => requestMode === 'toggle' ? !current : requestMode === 'close' ? false : true)
    }
  }, [initialQuery, openRequestKey, requestMode])

  useEffect(() => {
    if (openRequestKey !== undefined) return
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((current) => !current)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openRequestKey])

  useEffect(() => {
    if (!open) {
      setQuery(initialQuery)
      setHighlight(0)
    }
  }, [initialQuery, open])

  const close = useCallback(() => setOpen(false), [])

  const items = useMemo<PaletteItem[]>(() => {
    if (!open) return []
    const result: PaletteItem[] = []

    const threads = groups
      .flatMap((group) =>
        group.threads
          .filter((thread) => !thread.is_archived)
          .map((thread) => ({
            group,
            thread,
            projectLabel: group.workspace.path.split('/').pop() ?? group.workspace.path,
          })),
      )
      .sort((a, b) => Date.parse(b.thread.updated_at) - Date.parse(a.thread.updated_at))

    for (const { group, thread, projectLabel } of threads) {
      result.push({
        id: `thread:${thread.id}`,
        section: 'Threads',
        label: thread.title,
        sublabel: projectLabel,
        icon: <MessageSquare className="h-3.5 w-3.5" />,
        keywords: `${thread.title} ${projectLabel}`,
        run: () => onSelectThread(group.workspace.id, thread.id),
      })
    }

    if (onNewThread) {
      for (const group of groups) {
        const projectLabel = group.workspace.path.split('/').pop() ?? group.workspace.path
        result.push({
          id: `new:${group.workspace.id}`,
          section: 'Actions',
          label: `New thread in ${projectLabel}`,
          icon: <SquarePen className="h-3.5 w-3.5" />,
          keywords: `new thread create start ${projectLabel}`,
          run: () => onNewThread(group.workspace.id),
        })
      }
    }
    if (onOpenSettings) {
      result.push({
        id: 'settings',
        section: 'Actions',
        label: 'Open settings',
        icon: <Settings className="h-3.5 w-3.5" />,
        keywords: 'settings preferences options',
        run: onOpenSettings,
      })
    }

    const themeIcons = { system: Monitor, light: Sun, dark: Moon } as const
    for (const value of ['system', 'light', 'dark'] as const) {
      const Icon = themeIcons[value]
      result.push({
        id: `theme:${value}`,
        section: 'Appearance',
        label: `Theme: ${value.charAt(0).toUpperCase()}${value.slice(1)}`,
        icon: <Icon className="h-3.5 w-3.5" />,
        keywords: `theme mode appearance ${value} light dark system`,
        active: appearance.theme === value,
        run: () => updateAppearance({ theme: value }),
      })
    }
    for (const option of PALETTE_OPTIONS) {
      result.push({
        id: `palette:${option.value}`,
        section: 'Appearance',
        label: `Color theme: ${option.label}`,
        icon: <Palette className="h-3.5 w-3.5" />,
        keywords: `palette color theme ${option.label}`,
        active: appearance.palette === option.value,
        run: () => updateAppearance({ palette: option.value }),
      })
    }

    return result
  }, [appearance.palette, appearance.theme, groups, onNewThread, onOpenSettings, onSelectThread, open])

  const filtered = useMemo(() => {
    if (!query.trim()) {
      const threads = items.filter((item) => item.section === 'Threads').slice(0, 8)
      const rest = items.filter((item) => item.section !== 'Threads')
      return [...threads, ...rest]
    }
    return items
      .map((item) => ({ item, score: fuzzyScore(query.trim(), item.keywords) }))
      .filter((entry): entry is { item: PaletteItem; score: number } => entry.score !== null)
      .sort((a, b) => a.score - b.score)
      .map((entry) => entry.item)
      .slice(0, 30)
  }, [items, query])

  useEffect(() => {
    setHighlight(0)
  }, [query])

  const runItem = useCallback(
    (item: PaletteItem) => {
      close()
      item.run()
    },
    [close],
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlight((current) => Math.min(current + 1, filtered.length - 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight((current) => Math.max(current - 1, 0))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        const item = filtered[highlight]
        if (item) runItem(item)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    },
    [close, filtered, highlight, runItem],
  )

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-highlighted="true"]')
    node?.scrollIntoView({ block: 'nearest' })
  }, [highlight, filtered])

  if (!open || typeof document === 'undefined') return null

  let lastSection: PaletteItem['section'] | null = null

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-[var(--fd-overlay)] p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={handleKeyDown}
        className="mx-auto mt-[12vh] w-full max-w-lg overflow-hidden rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 shadow-[var(--fd-shadow-xl)]"
      >
        <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2.5">
          <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-muted" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search threads and commands…"
            aria-label="Search threads and commands"
            className="w-full bg-transparent text-[length:var(--fd-text-base)] text-fg-primary outline-none placeholder:text-fg-muted"
          />
          <Kbd>esc</Kbd>
        </div>

        <div ref={listRef} className="max-h-[46vh] overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <p className="px-2.5 py-6 text-center text-[length:var(--fd-text-sm)] text-fg-muted">
              No matches
            </p>
          ) : null}
          {filtered.map((item, index) => {
            const showHeader = item.section !== lastSection
            lastSection = item.section
            return (
              <React.Fragment key={item.id}>
                {showHeader ? (
                  <p className="px-2.5 pb-1 pt-2 text-[length:var(--fd-text-2xs)] font-medium uppercase tracking-[0.1em] text-fg-muted">
                    {item.section}
                  </p>
                ) : null}
                <button
                  type="button"
                  data-highlighted={index === highlight}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => runItem(item)}
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-[var(--fd-radius-md)] px-2.5 py-2 text-left',
                    index === highlight ? 'bg-surface-3' : undefined,
                  )}
                >
                  <span aria-hidden="true" className="shrink-0 text-fg-muted">
                    {item.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[length:var(--fd-text-sm)] text-fg-primary">
                    {item.label}
                  </span>
                  {item.sublabel ? (
                    <span className="flex shrink-0 items-center gap-1 text-[length:var(--fd-text-xs)] text-fg-muted">
                      <FolderClosed aria-hidden="true" className="h-3 w-3" />
                      {item.sublabel}
                    </span>
                  ) : null}
                  {item.active ? (
                    <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-accent" />
                  ) : null}
                </button>
              </React.Fragment>
            )
          })}
        </div>

        <div className="flex items-center gap-3 border-t border-border-subtle px-3 py-2 text-[length:var(--fd-text-2xs)] text-fg-muted">
          <span className="flex items-center gap-1">
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> navigate
          </span>
          <span className="flex items-center gap-1">
            <Kbd>↵</Kbd> open
          </span>
        </div>
      </div>
    </div>,
    document.body,
  )
})

import * as React from 'react'
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  Activity,
  FolderClosed,
  MessageSquare,
  Monitor,
  Moon,
  Search,
  Settings,
  SquarePen,
  Sun,
} from 'lucide-react'

import {
  compareThreads,
  deriveThreadAttentionPresentation,
  projectLabel as getProjectLabel,
  type ProjectGroup,
} from '@falcondeck/client-core'
import {
  Kbd,
  PALETTE_OPTIONS,
  PaletteSwatch,
  cn,
  resolveTheme,
  updateAppearance,
  useAppearance,
} from '@falcondeck/ui'

import { isComposingKeyboardEvent } from '../lib/keyboard'

type PaletteItem = {
  id: string
  kind: 'thread' | 'action' | 'appearance'
  section: 'Unread threads' | 'Threads' | 'Actions' | 'Appearance'
  label: string
  sublabel?: string
  icon: React.ReactNode
  search: PaletteSearchFields
  active?: boolean
  unread?: boolean
  run: () => void
}

export type PaletteSearchFields = {
  primary: string
  secondary: string
  keywords: string
}

const PRIORITY_THREAD_COMPARATOR = compareThreads('priority')
const MAX_SEARCH_RESULTS = 30

function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .trim()
}

function normalizeSearchFields(search: PaletteSearchFields): PaletteSearchFields {
  return {
    primary: normalizeSearchText(search.primary),
    secondary: normalizeSearchText(search.secondary),
    keywords: normalizeSearchText(search.keywords),
  }
}

function fieldScore(query: string, target: string): number | null {
  if (!target) return null
  if (target === query) return 0
  if (target.startsWith(query)) return 4

  let wordIndex = target.indexOf(query)
  while (wordIndex > 0 && /[a-z0-9]/.test(target[wordIndex - 1] ?? '')) {
    wordIndex = target.indexOf(query, wordIndex + 1)
  }
  if (wordIndex >= 0) return 12 + wordIndex

  const substringIndex = target.indexOf(query)
  if (substringIndex >= 0) return 32 + substringIndex

  let targetIndex = 0
  let gaps = 0
  for (const character of query) {
    const found = target.indexOf(character, targetIndex)
    if (found === -1) return null
    gaps += found - targetIndex
    targetIndex = found + 1
  }
  return 120 + gaps + Math.max(0, target.length - query.length) / 20
}

/**
 * Subsequence fuzzy score: lower is better, null means no match.
 * Substring hits rank above scattered subsequences; earlier hits rank higher.
 */
export function fuzzyScore(query: string, target: string): number | null {
  const q = normalizeSearchText(query)
  const t = normalizeSearchText(target)
  if (!q) return 0
  return fieldScore(q, t)
}

/**
 * Token-aware search across the visible label, project/path context, and
 * synonyms. Every token must match, while title matches remain strongest.
 */
export function paletteSearchScore(
  query: string,
  search: PaletteSearchFields,
): number | null {
  const normalizedQuery = normalizeSearchText(query)
  if (!normalizedQuery) return 0

  return normalizedPaletteSearchScore(normalizedQuery, normalizeSearchFields(search))
}

function normalizedPaletteSearchScore(
  normalizedQuery: string,
  search: PaletteSearchFields,
): number | null {
  const phraseScore = fieldScore(normalizedQuery, search.primary)
  let score = phraseScore === null ? 0 : phraseScore - 20

  for (const token of normalizedQuery.split(/\s+/)) {
    const candidates = [
      fieldScore(token, search.primary),
      fieldScore(token, search.secondary),
      fieldScore(token, search.keywords),
    ]
    const tokenScore = candidates.reduce<number | null>(
      (best, candidate, index) => {
        if (candidate === null) return best
        const weighted = candidate + index * 35
        return best === null || weighted < best ? weighted : best
      },
      null,
    )
    if (tokenScore === null) return null
    score += tokenScore
  }
  return score
}

export type CommandPaletteProps = {
  groups: ProjectGroup[]
  onSelectThread: (workspaceId: string, threadId: string) => void
  onNewThread?: (workspaceId: string) => void
  onOpenSettings?: () => void
  onOpenActivity?: () => void
  /** Controlled open request for hosts with customizable shortcuts. */
  openRequestKey?: number
  initialQuery?: string
  initialScope?: 'all' | 'threads'
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
  onOpenActivity,
  openRequestKey,
  initialQuery = '',
  initialScope = 'all',
  requestMode = 'open',
}: CommandPaletteProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const consumedOpenRequestKeyRef = useRef<number | undefined>(undefined)
  const listId = useId()
  const appearance = useAppearance()

  useEffect(() => {
    if (openRequestKey === undefined) return
    if (openRequestKey <= 0 || consumedOpenRequestKeyRef.current === openRequestKey) return
    consumedOpenRequestKeyRef.current = openRequestKey
    setQuery(initialQuery)
    setOpen((current) => {
      const next = requestMode === 'toggle' ? !current : requestMode !== 'close'
      if (!current && next && typeof document !== 'undefined') {
        returnFocusRef.current = document.activeElement as HTMLElement | null
      }
      return next
    })
  }, [initialQuery, openRequestKey, requestMode])

  useEffect(() => {
    if (openRequestKey !== undefined) return
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setOpen((current) => {
          if (!current && typeof document !== 'undefined') {
            returnFocusRef.current = document.activeElement as HTMLElement | null
          }
          return !current
        })
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

  useEffect(() => {
    if (open) return
    const returnFocus = returnFocusRef.current
    returnFocusRef.current = null
    returnFocus?.focus()
  }, [open])

  const items = useMemo<PaletteItem[]>(() => {
    if (!open) return []
    const result: PaletteItem[] = []

    // Unread threads get their own section, then the remaining threads are
    // ordered by actionable/running status. The running bucket stays stable
    // while streaming; settled buckets use recency, matching the sidebar.
    const threads = groups
      .flatMap((group) => {
        const projectLabel = getProjectLabel(group.workspace.path)
        return group.threads
          .filter((thread) => !thread.is_archived)
          .map((thread) => ({
            group,
            thread,
            projectLabel,
            unread: deriveThreadAttentionPresentation(thread).unread,
          }))
      })
      .sort((a, b) => PRIORITY_THREAD_COMPARATOR(a.thread, b.thread))

    for (const { group, thread, projectLabel: label, unread } of threads) {
      if (!unread) continue

      result.push({
        id: `thread:${thread.id}`,
        kind: 'thread',
        section: 'Unread threads',
        label: thread.title,
        sublabel: label,
        icon: <span className="h-2.5 w-2.5 rounded-full bg-info" />,
        search: normalizeSearchFields({
          primary: thread.title,
          secondary: `${label} ${group.workspace.path}`,
          keywords: `unread chat conversation thread ${thread.provider} ${thread.status} ${thread.variant?.branch ?? ''} ${thread.id} ${thread.native_session_id ?? ''}`,
        }),
        unread: true,
        run: () => onSelectThread(group.workspace.id, thread.id),
      })
    }

    for (const { group, thread, projectLabel: label, unread } of threads) {
      if (unread) continue

      result.push({
        id: `thread:${thread.id}`,
        kind: 'thread',
        section: 'Threads',
        label: thread.title,
        sublabel: label,
        icon: <MessageSquare className="h-3.5 w-3.5" />,
        search: normalizeSearchFields({
          primary: thread.title,
          secondary: `${label} ${group.workspace.path}`,
          keywords: `chat conversation thread ${thread.provider} ${thread.status} ${thread.variant?.branch ?? ''} ${thread.id} ${thread.native_session_id ?? ''}`,
        }),
        run: () => onSelectThread(group.workspace.id, thread.id),
      })
    }

    if (onNewThread) {
      for (const group of groups) {
        const label = getProjectLabel(group.workspace.path)
        result.push({
          id: `new:${group.workspace.id}`,
          kind: 'action',
          section: 'Actions',
          label: `New thread in ${label}`,
          icon: <SquarePen className="h-3.5 w-3.5" />,
          search: normalizeSearchFields({
            primary: `New thread in ${label}`,
            secondary: group.workspace.path,
            keywords: `new chat conversation thread create start`,
          }),
          run: () => onNewThread(group.workspace.id),
        })
      }
    }
    if (onOpenActivity) {
      result.push({
        id: 'activity',
        kind: 'action',
        section: 'Actions',
        label: 'Open Activity',
        icon: <Activity className="h-3.5 w-3.5" />,
        search: normalizeSearchFields({ primary: 'Open Activity', secondary: '', keywords: 'attention queue blocked failed unread running' }),
        run: onOpenActivity,
      })
    }
    if (onOpenSettings) {
      result.push({
        id: 'settings',
        kind: 'action',
        section: 'Actions',
        label: 'Open settings',
        icon: <Settings className="h-3.5 w-3.5" />,
        search: normalizeSearchFields({ primary: 'Open settings', secondary: '', keywords: 'settings preferences options' }),
        run: onOpenSettings,
      })
    }

    const themeIcons = { system: Monitor, light: Sun, dark: Moon } as const
    for (const value of ['system', 'light', 'dark'] as const) {
      const Icon = themeIcons[value]
      result.push({
        id: `theme:${value}`,
        kind: 'appearance',
        section: 'Appearance',
        label: `Theme: ${value.charAt(0).toUpperCase()}${value.slice(1)}`,
        icon: <Icon className="h-3.5 w-3.5" />,
        search: normalizeSearchFields({
          primary: `Theme: ${value}`,
          secondary: '',
          keywords: `theme mode appearance ${value} light dark system`,
        }),
        active: appearance.theme === value,
        run: () => updateAppearance({ theme: value }),
      })
    }
    for (const option of PALETTE_OPTIONS) {
      result.push({
        id: `palette:${option.value}`,
        kind: 'appearance',
        section: 'Appearance',
        label: `Color theme: ${option.label}`,
        icon: <PaletteSwatch preview={option.preview[resolveTheme(appearance.theme)]} size={14} />,
        search: normalizeSearchFields({
          primary: `Color theme: ${option.label}`,
          secondary: '',
          keywords: `palette color theme appearance ${option.label}`,
        }),
        active: appearance.palette === option.value,
        run: () => updateAppearance({ palette: option.value }),
      })
    }

    return result
  }, [appearance.palette, appearance.theme, groups, onNewThread, onOpenActivity, onOpenSettings, onSelectThread, open])

  const filtered = useMemo(() => {
    const scopedItems = initialScope === 'threads'
      ? items.filter((item) => item.kind === 'thread')
      : items
    if (!query.trim()) {
      const threads: PaletteItem[] = []
      const rest: PaletteItem[] = []
      for (const item of scopedItems) {
        if (item.kind === 'thread') {
          if (threads.length < 8) threads.push(item)
        } else {
          rest.push(item)
        }
      }
      return [...threads, ...rest]
    }
    const normalizedQuery = normalizeSearchText(query)
    const ranked: Array<{ item: PaletteItem; index: number; score: number }> = []
    for (let index = 0; index < scopedItems.length; index += 1) {
      const item = scopedItems[index]
      if (!item) continue
      const score = normalizedPaletteSearchScore(normalizedQuery, item.search)
      if (score === null) continue

      let low = 0
      let high = ranked.length
      while (low < high) {
        const middle = (low + high) >>> 1
        const candidate = ranked[middle]!
        if (candidate.score < score || (candidate.score === score && candidate.index < index)) {
          low = middle + 1
        } else {
          high = middle
        }
      }
      if (low < MAX_SEARCH_RESULTS) {
        ranked.splice(low, 0, { item, index, score })
        if (ranked.length > MAX_SEARCH_RESULTS) ranked.pop()
      }
    }
    return ranked.map((entry) => entry.item)
  }, [initialScope, items, query])

  useEffect(() => {
    setHighlight(0)
  }, [initialScope, query])

  useEffect(() => {
    setHighlight((current) => Math.min(current, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  const runItem = useCallback(
    (item: PaletteItem) => {
      close()
      item.run()
    },
    [close],
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (isComposingKeyboardEvent(event)) return
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlight((current) => filtered.length ? (current + 1) % filtered.length : 0)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight((current) => filtered.length ? (current - 1 + filtered.length) % filtered.length : 0)
      } else if (event.key === 'Home') {
        event.preventDefault()
        setHighlight(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        setHighlight(Math.max(0, filtered.length - 1))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        const item = filtered[highlight]
        if (item) runItem(item)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        close()
      } else if (event.key === 'Tab') {
        // A listbox is navigated with arrows; keep focus from escaping the
        // modal into the inert application underneath it.
        event.preventDefault()
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
            role="combobox"
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded="true"
            aria-activedescendant={filtered[highlight] ? `${listId}-${filtered[highlight].id}` : undefined}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={initialScope === 'threads' ? 'Search threads…' : 'Search threads and commands…'}
            aria-label={initialScope === 'threads' ? 'Search threads' : 'Search threads and commands'}
            className="w-full bg-transparent text-[length:var(--fd-text-base)] text-fg-primary outline-none placeholder:text-fg-muted"
          />
          <Kbd>esc</Kbd>
        </div>

        <span className="sr-only" role="status" aria-live="polite">
          {filtered.length} {filtered.length === 1 ? 'result' : 'results'}
        </span>
        <div id={listId} role="listbox" ref={listRef} className="max-h-[46vh] overflow-y-auto p-1.5">
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
                  <p role="presentation" className="px-2.5 pb-1 pt-2 text-[length:var(--fd-text-2xs)] font-medium uppercase tracking-[0.1em] text-fg-muted">
                    {item.section}
                  </p>
                ) : null}
                <button
                  id={`${listId}-${item.id}`}
                  type="button"
                  role="option"
                  aria-selected={index === highlight}
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
                      {!item.unread ? (
                        <FolderClosed aria-hidden="true" className="h-3 w-3" />
                      ) : null}
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

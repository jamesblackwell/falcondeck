import * as React from 'react'
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Check,
  Activity,
  FolderClosed,
  Gauge,
  Keyboard,
  MessageSquare,
  Monitor,
  Moon,
  Puzzle,
  Search,
  Settings,
  SquarePen,
  Sun,
  X,
  type LucideIcon,
} from 'lucide-react'

import {
  compareThreads,
  deriveThreadAttentionPresentation,
  projectLabel as getProjectLabel,
  wasTurnInterruptedByShutdown,
  type ProjectGroup,
  type ThreadAttentionPresentation,
  type ThreadMessageMatch,
  type ThreadSummary,
} from '@falcondeck/client-core'
import {
  ActivityDiamond,
  COLOR_THEME_OPTIONS,
  Kbd,
  PaletteSwatch,
  cn,
  previewAppearance,
  updateAppearance,
  usePersistedAppearance,
  type AppearanceSettings,
  type PalettePreview,
} from '@falcondeck/ui'

import { isComposingKeyboardEvent } from '../lib/keyboard'

type PaletteItem = {
  id: string
  kind: 'thread' | 'action' | 'appearance'
  section:
    | 'Needs attention'
    | 'Recent'
    | 'Message matches'
    | 'Actions'
    | 'Appearance'
    | 'Projects'
  label: string
  sublabel?: string
  /** Second line under the label, used for message-content excerpts. */
  snippet?: string
  /** Lowercased keywords to emphasise inside `snippet`. */
  snippetTokens?: readonly string[]
  /** Workspace this row belongs to; drives the `project:` scope filter. */
  projectId?: string
  icon: PaletteIcon
  search: PaletteSearchFields
  active?: boolean
  /** Live thread state ("Running", "Failed", …) shown right of the title. */
  status?: PaletteThreadStatus
  /** Relative timestamp ("4m", "6d") right-aligned on thread rows. */
  time?: string
  /** Rendered shortcut tokens ("⌘", "U") shown right-aligned on the row. */
  shortcut?: readonly string[]
  /** Applied to the document while the row is highlighted, then rolled back. */
  preview?: Partial<AppearanceSettings>
  /** Steps into a nested palette view instead of running and closing. */
  enters?: 'new-thread'
  run: () => void
}

type PaletteThreadStatus = {
  label: string
  tone: 'accent' | 'warning' | 'danger' | 'info' | 'muted'
}

const STATUS_TONE_CLASS: Record<PaletteThreadStatus['tone'], string> = {
  accent: 'text-accent',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
  muted: 'text-fg-muted',
}

/**
 * Same state vocabulary the sidebar row shows, condensed to one word so the
 * palette says whether a thread is mid-turn, waiting on you, or settled.
 */
function threadPaletteStatus(
  thread: ThreadSummary,
  attention: ThreadAttentionPresentation,
): PaletteThreadStatus {
  if (wasTurnInterruptedByShutdown(thread)) return { label: 'Stopped', tone: 'danger' }
  switch (attention.level) {
    case 'error':
      return { label: 'Failed', tone: 'danger' }
    case 'awaiting_response':
      return { label: attention.badgeLabel ?? 'Awaiting response', tone: 'warning' }
    case 'running':
      return { label: 'Running', tone: 'accent' }
    case 'unread':
      return { label: 'Unread', tone: 'info' }
    default:
      return { label: 'Idle', tone: 'muted' }
  }
}

function timeAgo(dateStr: string) {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

/** Whether a thread belongs in the palette's "Needs attention" section. */
function needsAttention(attention: ThreadAttentionPresentation): boolean {
  return (
    attention.unread ||
    attention.level === 'error' ||
    attention.level === 'awaiting_response'
  )
}

/**
 * Row order and section membership are captured when the palette opens and
 * kept for the whole open. Streaming snapshots keep repainting statuses and
 * timestamps, but rows never trade places under the pointer — with many
 * active threads the live priority sort made the list too jumpy to aim at.
 */
type FrozenThreadOrder = {
  order: Map<string, number>
  attention: Set<string>
  next: number
}

/**
 * Icons are described, not built, while items are assembled: the palette holds
 * an entry per thread, so eagerly creating ~1.5k React elements cost more at
 * open than everything else combined. Only the rows on screen render one.
 */
type PaletteIcon =
  | { kind: 'status'; tone: PaletteThreadStatus['tone'] }
  | { kind: 'glyph'; Glyph: LucideIcon }
  | { kind: 'swatch'; preview: PalettePreview }

/**
 * Emphasises the searched words inside a message excerpt, so the reason a
 * thread is in the list is visible without reading the whole line.
 */
function highlightSnippet(
  snippet: string,
  tokens: readonly string[] | undefined,
): React.ReactNode {
  if (!tokens?.length) return snippet
  const escaped = tokens
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .filter(Boolean)
  if (!escaped.length) return snippet
  const pattern = new RegExp(`(${escaped.join('|')})`, 'gi')
  return snippet.split(pattern).map((part, index) =>
    index % 2 === 1 ? (
      <mark key={index} className="bg-transparent font-medium text-fg-secondary">
        {part}
      </mark>
    ) : (
      part
    ),
  )
}

function renderPaletteIcon(icon: PaletteIcon): React.ReactNode {
  if (icon.kind === 'glyph') return <icon.Glyph className="h-3.5 w-3.5" />
  if (icon.kind === 'swatch') return <PaletteSwatch preview={icon.preview} size={14} />
  switch (icon.tone) {
    case 'accent':
      return <ActivityDiamond />
    case 'danger':
      return <span className="h-2.5 w-2.5 rounded-full bg-danger" />
    case 'warning':
      return (
        <span className="h-2.5 w-2.5 rounded-full bg-warning shadow-[0_0_0_3px_var(--fd-warning-muted)]" />
      )
    case 'info':
      return <span className="h-2.5 w-2.5 rounded-full bg-info" />
    default:
      return <MessageSquare className="h-3.5 w-3.5" />
  }
}

/**
 * Shortcut hints for the actions the palette offers, so the palette doubles as
 * the place people learn the bindings. Tokens are pre-rendered by the host,
 * which owns the (customizable) keymap.
 */
export type PaletteShortcutHints = {
  activity?: readonly string[]
  settings?: readonly string[]
  usage?: readonly string[]
  keyboardShortcuts?: readonly string[]
}

export type PaletteSearchFields = {
  primary: string
  secondary: string
  keywords: string
}

const PRIORITY_THREAD_COMPARATOR = compareThreads('priority')
const MAX_SEARCH_RESULTS = 30
/** Browse-view teaser caps, per section, when no project scope is active. */
const MAX_BROWSE_ATTENTION = 6
const MAX_BROWSE_RECENT = 6
/** Lowest score `fieldScore` gives a scattered-subsequence match. */
const SUBSEQUENCE_SCORE_BASE = 120
/** Added per token that only matched as a subsequence, to sort guesses last. */
const WEAK_MATCH_PENALTY = 1000

/** Stable default so an unset hints prop does not rebuild the item list. */
const NO_SHORTCUT_HINTS: PaletteShortcutHints = {}
/** Stable empty result, so clearing matches cannot loop the fetch effect. */
const NO_MESSAGE_MATCHES: readonly ThreadMessageMatch[] = []

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

type CachedThreadSearchFields = {
  title: string
  secondary: string
  keywords: string
  fields: PaletteSearchFields
}

/**
 * Thread search fields survive every snapshot update while a thread streams,
 * and NFKD normalization is not free at scale. Cache the normalized result per
 * thread id and only redo it when a raw input actually changed.
 */
function cachedThreadSearchFields(
  cache: Map<string, CachedThreadSearchFields>,
  threadId: string,
  title: string,
  secondary: string,
  keywords: string,
): PaletteSearchFields {
  const cached = cache.get(threadId)
  if (
    cached &&
    cached.title === title &&
    cached.secondary === secondary &&
    cached.keywords === keywords
  ) {
    return cached.fields
  }
  const fields = normalizeSearchFields({ primary: title, secondary, keywords })
  cache.set(threadId, { title, secondary, keywords, fields })
  return fields
}

/** Word characters for boundary detection, without allocating a regex match. */
function isWordCharCode(code: number): boolean {
  // 0-9, a-z (targets are already lowercased by normalizeSearchText).
  return (code >= 48 && code <= 57) || (code >= 97 && code <= 122)
}

function fieldScore(query: string, target: string): number | null {
  if (!target) return null
  // One indexOf answers exact/prefix/word/substring; the old version paid for
  // up to four scans of the same string per field, per item, per keystroke.
  const first = target.indexOf(query)
  if (first === 0) return target.length === query.length ? 0 : 4

  if (first > 0) {
    let wordIndex = first
    while (wordIndex > 0 && isWordCharCode(target.charCodeAt(wordIndex - 1))) {
      wordIndex = target.indexOf(query, wordIndex + 1)
    }
    if (wordIndex > 0) return 12 + wordIndex
    return 32 + first
  }

  // Scattered-subsequence fallback, walked by char code: the old version
  // iterated the query as strings and called indexOf per character, which
  // allocated on every non-matching candidate — the bulk of a keystroke's GC.
  let targetIndex = 0
  let gaps = 0
  for (let queryIndex = 0; queryIndex < query.length; queryIndex += 1) {
    const code = query.charCodeAt(queryIndex)
    let found = -1
    while (targetIndex < target.length) {
      if (target.charCodeAt(targetIndex) === code) {
        found = targetIndex
        break
      }
      targetIndex += 1
    }
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

  return normalizedPaletteSearchScore(
    normalizedQuery,
    normalizedQuery.split(/\s+/),
    normalizeSearchFields(search),
  )
}

/**
 * Tokens are split once per query by the caller, not once per candidate: with
 * ~1.5k threads the per-item split dominated both CPU and GC during typing.
 */
function normalizedPaletteSearchScore(
  normalizedQuery: string,
  queryTokens: readonly string[],
  search: PaletteSearchFields,
): number | null {
  const phraseScore = fieldScore(normalizedQuery, search.primary)
  let score = phraseScore === null ? 0 : phraseScore - 20

  for (const token of queryTokens) {
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
    // A token that only matched as a scattered subsequence is a guess, not a
    // hit; the penalty keeps such rows ranked last and lets callers drop them
    // when something better (a message-content match) exists.
    if (tokenScore >= SUBSEQUENCE_SCORE_BASE) score += WEAK_MATCH_PENALTY
    score += tokenScore
  }
  return score
}

/**
 * `project:` prefix support. Typing `project:falcondeck ` — or clicking the
 * search affordance on a sidebar project row — narrows the palette to one
 * workspace, shown as a removable chip instead of raw text.
 */
const PROJECT_PREFIX_PATTERN = /^project:([^\s]+)\s(.*)$/i

function projectMatchKey(value: string): string {
  return normalizeSearchText(value).replace(/[^a-z0-9]/g, '')
}

/**
 * Resolve a typed prefix token to exactly one project. Ambiguous tokens are
 * left as plain text so the query still searches instead of silently picking.
 */
function resolveProjectToken(
  groups: ProjectGroup[],
  token: string,
): string | null {
  const wanted = projectMatchKey(token)
  if (!wanted) return null
  const labels = groups.map((group) => ({
    id: group.workspace.id,
    key: projectMatchKey(getProjectLabel(group.workspace.path)),
  }))
  const exact = labels.filter((entry) => entry.key === wanted)
  if (exact.length === 1) return exact[0]!.id
  if (exact.length > 1) return null
  const prefixed = labels.filter((entry) => entry.key.startsWith(wanted))
  return prefixed.length === 1 ? prefixed[0]!.id : null
}

/** Shortest query worth sending to the message index. */
const MIN_MESSAGE_QUERY_CHARS = 3
/** Keystroke quiet period before the message index is asked. */
const MESSAGE_SEARCH_DEBOUNCE_MS = 180
/** Message matches shown under the title results. */
const MAX_MESSAGE_MATCHES = 8
/** Title matches kept on screen once message matches are also showing. */
const MAX_TITLES_WITH_MESSAGES = 12

export type SearchThreadMessages = (
  query: string,
  options: { workspaceId: string | null; signal: AbortSignal },
) => Promise<ThreadMessageMatch[]>

export type CommandPaletteProps = {
  groups: ProjectGroup[]
  onSelectThread: (workspaceId: string, threadId: string) => void
  onNewThread?: (workspaceId: string) => void
  onOpenSettings?: () => void
  onOpenUsage?: () => void
  onOpenActivity?: () => void
  onOpenKeyboardShortcuts?: () => void
  onOpenPlugins?: () => void
  /** Searches indexed user messages; omit to keep the palette title-only. */
  onSearchMessages?: SearchThreadMessages
  shortcutHints?: PaletteShortcutHints
  /** Controlled open request for hosts with customizable shortcuts. */
  openRequestKey?: number
  initialQuery?: string
  initialScope?: 'all' | 'threads'
  /** Opens the palette already scoped to one project's threads. */
  initialProjectId?: string | null
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
  onOpenUsage,
  onOpenActivity,
  onOpenKeyboardShortcuts,
  onOpenPlugins,
  onSearchMessages,
  shortcutHints = NO_SHORTCUT_HINTS,
  openRequestKey,
  initialQuery = '',
  initialScope = 'all',
  initialProjectId = null,
  requestMode = 'open',
}: CommandPaletteProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  // Scope chip: while set, the list only contains this project's threads.
  const [projectId, setProjectId] = useState<string | null>(null)
  // 'new-thread' is the palette's one nested step: pick the project to start in.
  const [mode, setMode] = useState<'root' | 'new-thread'>('root')
  const [highlight, setHighlight] = useState(0)
  const frozenOrderRef = useRef<FrozenThreadOrder | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const returnFocusRef = useRef<HTMLElement | null>(null)
  const consumedOpenRequestKeyRef = useRef<number | undefined>(undefined)
  const searchFieldsCacheRef = useRef(new Map<string, CachedThreadSearchFields>())
  const listId = useId()
  const appearance = usePersistedAppearance()

  useEffect(() => {
    if (openRequestKey === undefined) return
    if (openRequestKey <= 0 || consumedOpenRequestKeyRef.current === openRequestKey) return
    consumedOpenRequestKeyRef.current = openRequestKey
    setQuery(initialQuery)
    setProjectId(initialProjectId)
    setOpen((current) => {
      const next = requestMode === 'toggle' ? !current : requestMode !== 'close'
      if (!current && next && typeof document !== 'undefined') {
        returnFocusRef.current = document.activeElement as HTMLElement | null
      }
      return next
    })
  }, [initialProjectId, initialQuery, openRequestKey, requestMode])

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
      setProjectId(initialProjectId)
      setMode('root')
      setHighlight(0)
      frozenOrderRef.current = null
    }
  }, [initialProjectId, initialQuery, open])

  const close = useCallback(() => setOpen(false), [])

  useEffect(() => {
    if (open) return
    const returnFocus = returnFocusRef.current
    returnFocusRef.current = null
    returnFocus?.focus()
  }, [open])

  const items = useMemo<PaletteItem[]>(() => {
    if (!open) return []

    // The new-thread step swaps the whole list for a project picker: one row
    // per project, searched with the same scorer, chosen with the same keys.
    if (mode === 'new-thread') {
      if (!onNewThread) return []
      return groups.map((group) => {
        const label = getProjectLabel(group.workspace.path)
        return {
          id: `new:${group.workspace.id}`,
          kind: 'action' as const,
          section: 'Projects' as const,
          label,
          sublabel: group.workspace.path,
          projectId: group.workspace.id,
          icon: { kind: 'glyph' as const, Glyph: FolderClosed },
          search: normalizeSearchFields({
            primary: label,
            secondary: group.workspace.path,
            keywords: 'new chat conversation thread create start project',
          }),
          run: () => onNewThread(group.workspace.id),
        }
      })
    }

    const result: PaletteItem[] = []
    const searchCache = searchFieldsCacheRef.current

    // Threads needing a decision (failed / awaiting / unread) come first, then
    // the rest in priority order — running work above settled, recency inside.
    const threads = groups
      .flatMap((group) => {
        const projectLabel = getProjectLabel(group.workspace.path)
        return group.threads
          .filter((thread) => !thread.is_archived)
          .map((thread) => {
            const attention = deriveThreadAttentionPresentation(thread)
            return {
              group,
              thread,
              projectLabel,
              unread: attention.unread,
              attention,
              status: threadPaletteStatus(thread, attention),
            }
          })
      })
      .sort((a, b) => PRIORITY_THREAD_COMPARATOR(a.thread, b.thread))

    const liveThreadIds = new Set(threads.map(({ thread }) => thread.id))
    for (const id of searchCache.keys()) {
      if (!liveThreadIds.has(id)) searchCache.delete(id)
    }

    // Freeze order and section membership for this open (see FrozenThreadOrder).
    // Threads created mid-open append after the frozen rows instead of cutting
    // in, so an arrival cannot displace the row about to be clicked either.
    let frozen = frozenOrderRef.current
    if (!frozen) {
      frozen = { order: new Map(), attention: new Set(), next: 0 }
      frozenOrderRef.current = frozen
    }
    for (const entry of threads) {
      if (frozen.order.has(entry.thread.id)) continue
      frozen.order.set(entry.thread.id, frozen.next++)
      if (needsAttention(entry.attention)) frozen.attention.add(entry.thread.id)
    }
    const frozenOrder = frozen.order
    const frozenAttention = frozen.attention
    threads.sort(
      (a, b) =>
        (frozenOrder.get(a.thread.id) ?? 0) - (frozenOrder.get(b.thread.id) ?? 0),
    )

    for (const pass of ['attention', 'recent'] as const) {
      for (const { group, thread, projectLabel: label, status } of threads) {
        const attentionRow = frozenAttention.has(thread.id)
        if ((pass === 'attention') !== attentionRow) continue

        result.push({
          id: `thread:${thread.id}`,
          kind: 'thread',
          section: attentionRow ? 'Needs attention' : 'Recent',
          label: thread.title,
          sublabel: label,
          projectId: group.workspace.id,
          icon: { kind: 'status', tone: status.tone },
          // "Idle" said nothing the timestamp does not; quiet rows stay quiet.
          status: status.label === 'Idle' ? undefined : status,
          time: timeAgo(thread.updated_at),
          search: cachedThreadSearchFields(
            searchCache,
            thread.id,
            thread.title,
            `${label} ${group.workspace.path}`,
            `${attentionRow ? 'unread ' : ''}chat conversation thread ${status.label} ${thread.provider} ${thread.status} ${thread.variant?.branch ?? ''} ${thread.id} ${thread.native_session_id ?? ''}`,
          ),
          run: () => onSelectThread(group.workspace.id, thread.id),
        })
      }
    }

    if (onNewThread) {
      // One action for what used to be a row per project: choosing it keeps
      // the palette open and steps into the project picker above.
      result.push({
        id: 'new-thread',
        kind: 'action',
        section: 'Actions',
        label: 'New thread…',
        icon: { kind: 'glyph', Glyph: SquarePen },
        search: normalizeSearchFields({
          primary: 'New thread',
          secondary: '',
          keywords: 'new chat conversation thread create start compose project',
        }),
        enters: 'new-thread',
        run: () => {},
      })
    }
    if (onOpenActivity) {
      result.push({
        id: 'activity',
        kind: 'action',
        section: 'Actions',
        label: 'Open Activity',
        icon: { kind: 'glyph', Glyph: Activity },
        shortcut: shortcutHints.activity,
        search: normalizeSearchFields({ primary: 'Open Activity', secondary: '', keywords: 'attention queue blocked failed unread running' }),
        run: onOpenActivity,
      })
    }
    if (onOpenPlugins) {
      result.push({
        id: 'plugins',
        kind: 'action',
        section: 'Actions',
        label: 'Open Plugins',
        icon: { kind: 'glyph', Glyph: Puzzle },
        search: normalizeSearchFields({ primary: 'Open Plugins', secondary: '', keywords: 'plugins skills mcp servers connectors install registry' }),
        run: onOpenPlugins,
      })
    }
    if (onOpenKeyboardShortcuts) {
      result.push({
        id: 'keyboard-shortcuts',
        kind: 'action',
        section: 'Actions',
        label: 'Keyboard shortcuts',
        icon: { kind: 'glyph', Glyph: Keyboard },
        shortcut: shortcutHints.keyboardShortcuts,
        search: normalizeSearchFields({ primary: 'Keyboard shortcuts', secondary: '', keywords: 'keybindings hotkeys bindings shortcuts keymap help cheatsheet' }),
        run: onOpenKeyboardShortcuts,
      })
    }
    if (onOpenSettings) {
      result.push({
        id: 'settings',
        kind: 'action',
        section: 'Actions',
        label: 'Open settings',
        icon: { kind: 'glyph', Glyph: Settings },
        shortcut: shortcutHints.settings,
        search: normalizeSearchFields({ primary: 'Open settings', secondary: '', keywords: 'settings preferences options' }),
        run: onOpenSettings,
      })
    }
    if (onOpenUsage) {
      result.push({
        id: 'usage',
        kind: 'action',
        section: 'Actions',
        label: 'Subscription usage & limits',
        icon: { kind: 'glyph', Glyph: Gauge },
        shortcut: shortcutHints.usage,
        search: normalizeSearchFields({
          primary: 'Subscription usage & limits',
          secondary: 'Codex, Claude Code, Grok, Cursor',
          keywords: 'usage limits subscription quota rate plan session tokens reset cursor',
        }),
        run: onOpenUsage,
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
        icon: { kind: 'glyph', Glyph: Icon },
        search: normalizeSearchFields({
          primary: `Theme: ${value}`,
          secondary: '',
          keywords: `theme mode appearance ${value} light dark system`,
        }),
        active: appearance.theme === value,
        preview: { theme: value },
        run: () => updateAppearance({ theme: value }),
      })
    }
    for (const option of COLOR_THEME_OPTIONS) {
      const selected = option.appearance === 'light'
        ? appearance.lightColorTheme === option.value
        : appearance.darkColorTheme === option.value
      result.push({
        id: `color-theme:${option.value}`,
        kind: 'appearance',
        section: 'Appearance',
        label: `${option.appearance === 'light' ? 'Light' : 'Dark'} theme: ${option.label}`,
        icon: { kind: 'swatch', preview: option.preview },
        search: normalizeSearchFields({
          primary: `${option.appearance} theme: ${option.label}`,
          secondary: '',
          keywords: `palette color theme appearance ${option.appearance} ${option.label}`,
        }),
        active: selected,
        // A light theme is invisible while the app renders dark, so the
        // preview flips the mode too — selecting the row still only saves the
        // colour choice, exactly as clicking it always did.
        preview:
          option.appearance === 'light'
            ? { theme: 'light', lightColorTheme: option.value }
            : { theme: 'dark', darkColorTheme: option.value },
        run: () => {
          if (option.appearance === 'light') {
            updateAppearance({ lightColorTheme: option.value })
          } else {
            updateAppearance({ darkColorTheme: option.value })
          }
        },
      })
    }

    return result
  }, [appearance.darkColorTheme, appearance.lightColorTheme, appearance.theme, groups, mode, onNewThread, onOpenActivity, onOpenKeyboardShortcuts, onOpenPlugins, onOpenSettings, onOpenUsage, onSelectThread, open, shortcutHints])

  // A project that has since disappeared (removed, or a stale request) must
  // not silently hide every result, so the chip only survives while it resolves.
  const activeProject = useMemo(
    () =>
      projectId
        ? (groups.find((group) => group.workspace.id === projectId) ?? null)
        : null,
    [groups, projectId],
  )
  const activeProjectLabel = activeProject
    ? getProjectLabel(activeProject.workspace.path)
    : null

  // Message-content matches come from the daemon's excerpt index, so they are
  // fetched rather than derived: titles stay instant, content follows.
  const [messageMatches, setMessageMatches] = useState<readonly ThreadMessageMatch[]>([])
  const scopedWorkspaceId = activeProject?.workspace.id ?? null

  useEffect(() => {
    const trimmed = query.trim()
    if (
      !open ||
      mode !== 'root' ||
      !onSearchMessages ||
      trimmed.length < MIN_MESSAGE_QUERY_CHARS
    ) {
      setMessageMatches(NO_MESSAGE_MATCHES)
      return
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      onSearchMessages(trimmed, {
        workspaceId: scopedWorkspaceId,
        signal: controller.signal,
      })
        .then((matches) => {
          if (!controller.signal.aborted) setMessageMatches(matches)
        })
        .catch(() => {
          // An aborted or failed lookup just leaves the title results alone.
          if (!controller.signal.aborted) setMessageMatches(NO_MESSAGE_MATCHES)
        })
    }, MESSAGE_SEARCH_DEBOUNCE_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [mode, onSearchMessages, open, query, scopedWorkspaceId])

  /** Threads by id, for turning message matches into rows. */
  const threadIndex = useMemo(() => {
    if (!open) return new Map<string, { thread: ThreadSummary; group: ProjectGroup }>()
    const index = new Map<string, { thread: ThreadSummary; group: ProjectGroup }>()
    for (const group of groups) {
      for (const thread of group.threads) index.set(thread.id, { thread, group })
    }
    return index
  }, [groups, open])

  const filtered = useMemo<{ items: PaletteItem[]; strong: number }>(() => {
    let scopedItems = initialScope === 'threads'
      ? items.filter((item) => item.kind === 'thread')
      : items
    if (activeProject) {
      const scopeId = activeProject.workspace.id
      // The New thread action survives the scope: with the project already
      // chosen it skips its picker step and creates there directly.
      scopedItems = scopedItems.filter(
        (item) => item.projectId === scopeId || item.enters === 'new-thread',
      )
    }
    if (!query.trim()) {
      // Browsing all projects shows a short teaser per thread section; inside
      // a single project the browse list *is* the answer, so it runs longer.
      const attentionLimit = activeProject ? MAX_SEARCH_RESULTS : MAX_BROWSE_ATTENTION
      const recentLimit = activeProject ? MAX_SEARCH_RESULTS : MAX_BROWSE_RECENT
      const attention: PaletteItem[] = []
      const recent: PaletteItem[] = []
      const rest: PaletteItem[] = []
      for (const item of scopedItems) {
        if (item.kind !== 'thread') {
          rest.push(item)
        } else if (item.section === 'Needs attention') {
          if (attention.length < attentionLimit) attention.push(item)
        } else if (recent.length < recentLimit) {
          recent.push(item)
        }
      }
      const browse = [...attention, ...recent, ...rest]
      return { items: browse, strong: browse.length }
    }
    const normalizedQuery = normalizeSearchText(query)
    const queryTokens = normalizedQuery.split(/\s+/)
    const ranked: Array<{ item: PaletteItem; index: number; score: number }> = []
    for (let index = 0; index < scopedItems.length; index += 1) {
      const item = scopedItems[index]
      if (!item) continue
      const score = normalizedPaletteSearchScore(normalizedQuery, queryTokens, item.search)
      if (score === null) continue
      // Once the window is full, most candidates lose outright. Rejecting them
      // before the binary search skips both the walk and the entry allocation;
      // ties can never win either, because index only grows.
      if (ranked.length === MAX_SEARCH_RESULTS && score >= ranked[MAX_SEARCH_RESULTS - 1]!.score) {
        continue
      }

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
    return {
      items: ranked.map((entry) => entry.item),
      // Ranked ascending, so every strong match precedes every weak one.
      strong: ranked.filter((entry) => entry.score < WEAK_MATCH_PENALTY).length,
    }
  }, [activeProject, initialScope, items, query])

  /**
   * Message rows are appended after the title results and never duplicate a
   * thread already shown: a thread whose title matched needs no excerpt.
   */
  const messageItems = useMemo<PaletteItem[]>(() => {
    if (!messageMatches.length) return []
    const snippetTokens = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const alreadyShown = new Set(
      filtered.items
        .filter((item) => item.kind === 'thread')
        .map((item) => item.id.slice('thread:'.length)),
    )
    // The daemon ranks opening matches above trailing ones but knows nothing
    // about recency, which is the tie-breaker that makes a list feel sorted.
    const ordered = [...messageMatches].sort((left, right) => {
      const byPosition =
        (left.position === 'opening' ? 0 : 1) - (right.position === 'opening' ? 0 : 1)
      if (byPosition !== 0) return byPosition
      const leftThread = threadIndex.get(left.thread_id)?.thread
      const rightThread = threadIndex.get(right.thread_id)?.thread
      return (rightThread?.updated_at ?? '').localeCompare(leftThread?.updated_at ?? '')
    })

    const rows: PaletteItem[] = []
    for (const match of ordered) {
      if (rows.length >= MAX_MESSAGE_MATCHES) break
      if (alreadyShown.has(match.thread_id)) continue
      const entry = threadIndex.get(match.thread_id)
      if (!entry || entry.thread.is_archived) continue
      const attention = deriveThreadAttentionPresentation(entry.thread)
      const status = threadPaletteStatus(entry.thread, attention)
      rows.push({
        id: `message:${match.thread_id}`,
        kind: 'thread',
        section: 'Message matches',
        label: entry.thread.title,
        sublabel: getProjectLabel(entry.group.workspace.path),
        snippet: match.snippet,
        snippetTokens,
        projectId: entry.group.workspace.id,
        icon: { kind: 'status', tone: status.tone },
        status: status.label === 'Idle' ? undefined : status,
        time: timeAgo(entry.thread.updated_at),
        // Ranking is the daemon's; these rows bypass the fuzzy scorer.
        search: { primary: '', secondary: '', keywords: '' },
        run: () => onSelectThread(entry.group.workspace.id, entry.thread.id),
      })
    }
    return rows
  }, [filtered, messageMatches, onSelectThread, query, threadIndex])

  const visible = useMemo(() => {
    if (!messageItems.length) return filtered.items
    // Fuzzy title matching fills its window with scattered-subsequence guesses
    // on a multi-word query. Once real message matches exist, those guesses are
    // noise standing between the query and its answer.
    const titles = filtered.items.slice(
      0,
      Math.min(filtered.strong, MAX_TITLES_WITH_MESSAGES),
    )
    return [...titles, ...messageItems]
  }, [filtered, messageItems])

  useEffect(() => {
    setHighlight(0)
  }, [initialScope, mode, projectId, query])

  useEffect(() => {
    setHighlight((current) => Math.min(current, Math.max(0, visible.length - 1)))
  }, [visible.length])

  // Try the highlighted theme on for real. Rolls back when the highlight moves
  // off an appearance row, and when the palette closes without a selection —
  // committing goes through `updateAppearance`, which clears the preview too.
  useEffect(() => {
    if (!open) return
    previewAppearance(visible[highlight]?.preview ?? null)
  }, [highlight, open, visible])

  useEffect(() => {
    if (!open) return
    return () => previewAppearance(null)
  }, [open])

  // Typing the prefix by hand is the keyboard route to the same scope the
  // sidebar row's search icon sets.
  const handleQueryChange = useCallback(
    (value: string) => {
      const match =
        projectId || mode !== 'root' ? null : PROJECT_PREFIX_PATTERN.exec(value)
      const resolved = match ? resolveProjectToken(groups, match[1]!) : null
      if (match && resolved) {
        setProjectId(resolved)
        setQuery(match[2] ?? '')
        return
      }
      setQuery(value)
    },
    [groups, mode, projectId],
  )

  const clearProjectScope = useCallback(() => {
    setProjectId(null)
    inputRef.current?.focus()
  }, [])

  const runItem = useCallback(
    (item: PaletteItem) => {
      if (item.enters === 'new-thread') {
        // Already scoped to a project — the second step would only ask what
        // the chip has answered.
        if (scopedWorkspaceId && onNewThread) {
          close()
          onNewThread(scopedWorkspaceId)
          return
        }
        setMode('new-thread')
        setQuery('')
        setHighlight(0)
        inputRef.current?.focus()
        return
      }
      close()
      item.run()
    },
    [close, onNewThread, scopedWorkspaceId],
  )

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (isComposingKeyboardEvent(event)) return
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setHighlight((current) => visible.length ? (current + 1) % visible.length : 0)
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setHighlight((current) => visible.length ? (current - 1 + visible.length) % visible.length : 0)
      } else if (event.key === 'Home') {
        event.preventDefault()
        setHighlight(0)
      } else if (event.key === 'End') {
        event.preventDefault()
        setHighlight(Math.max(0, visible.length - 1))
      } else if (event.key === 'Enter') {
        event.preventDefault()
        const item = visible[highlight]
        if (item) runItem(item)
      } else if (event.key === 'Backspace' && mode === 'new-thread' && query === '') {
        // Chip-style deletion, one level at a time: back out of the picker
        // step first, exactly like deleting a scope chip.
        event.preventDefault()
        setMode('root')
        setQuery('')
      } else if (event.key === 'Backspace' && projectId && query === '') {
        // Chip-style deletion: the empty field's next backspace drops the
        // scope rather than closing the palette.
        event.preventDefault()
        clearProjectScope()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        if (mode === 'new-thread') {
          // Escape retreats one step; only the root view closes the palette.
          setMode('root')
          setQuery('')
        } else {
          close()
        }
      } else if (event.key === 'Tab') {
        // A listbox is navigated with arrows; keep focus from escaping the
        // modal into the inert application underneath it.
        event.preventDefault()
      }
    },
    [clearProjectScope, close, highlight, mode, projectId, query, runItem, visible],
  )

  const scrolledQueryRef = useRef(query)
  useEffect(() => {
    const list = listRef.current
    if (!list) return
    // Typing always resets the highlight to the first row, so the list only
    // needs rewinding — reading layout to decide would force a synchronous
    // reflow on every keystroke, which measured worse than the scroll itself.
    if (scrolledQueryRef.current !== query) {
      scrolledQueryRef.current = query
      list.scrollTop = 0
      return
    }
    const node = list.querySelector<HTMLElement>('[data-highlighted="true"]')
    node?.scrollIntoView({ block: 'nearest' })
  }, [highlight, query, visible])

  if (!open || typeof document === 'undefined') return null

  let lastSection: PaletteItem['section'] | null = null
  let renderedHeader = false
  const isSearching = query.trim().length > 0
  const searchLabel =
    mode === 'new-thread'
      ? 'Choose a project'
      : activeProjectLabel
        ? `Search threads in ${activeProjectLabel}`
        : initialScope === 'threads'
          ? 'Search threads'
          : 'Search threads and commands'

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
        className="mx-auto mt-[12vh] w-full max-w-xl overflow-hidden rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 shadow-[var(--fd-shadow-xl)]"
      >
        <div className="flex items-center gap-2 border-b border-border-subtle px-3 py-2.5">
          <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-fg-muted" />
          {mode === 'new-thread' ? (
            // Breadcrumb for the step, styled like the project scope chip so
            // "you are inside something" reads the same both ways.
            <span className="flex shrink-0 items-center gap-1 rounded-[var(--fd-radius-sm)] bg-surface-3 px-1.5 py-0.5 text-[length:var(--fd-text-xs)] text-fg-secondary">
              <SquarePen aria-hidden="true" className="h-3 w-3 shrink-0 text-fg-muted" />
              New thread
            </span>
          ) : null}
          {activeProjectLabel ? (
            <span className="flex max-w-[12rem] shrink-0 items-center gap-1 rounded-[var(--fd-radius-sm)] bg-surface-3 py-0.5 pl-1.5 pr-1 text-[length:var(--fd-text-xs)] text-fg-secondary">
              <FolderClosed aria-hidden="true" className="h-3 w-3 shrink-0 text-fg-muted" />
              <span className="truncate">{activeProjectLabel}</span>
              <button
                type="button"
                onClick={clearProjectScope}
                aria-label={`Search all projects instead of ${activeProjectLabel}`}
                className="fd-focus shrink-0 rounded-[var(--fd-radius-sm)] text-fg-muted transition-colors duration-[var(--fd-duration-fast)] hover:text-fg-primary"
              >
                <X aria-hidden="true" className="h-3 w-3" />
              </button>
            </span>
          ) : null}
          <input
            autoFocus
            ref={inputRef}
            role="combobox"
            aria-autocomplete="list"
            aria-controls={listId}
            aria-expanded="true"
            aria-activedescendant={visible[highlight] ? `${listId}-${visible[highlight].id}` : undefined}
            value={query}
            onChange={(event) => handleQueryChange(event.target.value)}
            placeholder={searchLabel + '…'}
            aria-label={searchLabel}
            className="w-full bg-transparent text-[length:var(--fd-text-base)] text-fg-primary outline-none placeholder:text-fg-muted"
          />
          <Kbd>esc</Kbd>
        </div>

        <span className="sr-only" role="status" aria-live="polite">
          {visible.length} {visible.length === 1 ? 'result' : 'results'}
        </span>
        <div id={listId} role="listbox" ref={listRef} className="max-h-[52vh] overflow-y-auto p-1.5">
          {visible.length === 0 ? (
            <p className="px-2.5 py-6 text-center text-[length:var(--fd-text-sm)] text-fg-muted">
              No matches
            </p>
          ) : null}
          {visible.map((item, index) => {
            // While searching the list is pure relevance order, so section
            // headers would only repeat and push results apart. Sections stay
            // for the unfiltered browse view — and for message matches, which
            // need the label to explain why a title that does not match is here.
            const showHeader =
              item.section !== lastSection &&
              (!isSearching || item.section === 'Message matches')
            lastSection = item.section
            const firstHeader = showHeader && !renderedHeader
            if (showHeader) renderedHeader = true
            return (
              <React.Fragment key={item.id}>
                {showHeader ? (
                  // A hairline splits each later section from the one above,
                  // so the groups read as bands rather than one long list.
                  <p
                    role="presentation"
                    className={cn(
                      'px-2.5 pb-1 pt-2 text-[length:var(--fd-text-2xs)] font-medium uppercase tracking-[0.1em] text-fg-muted',
                      !firstHeader && 'mt-1.5 border-t border-border-subtle pt-2.5',
                    )}
                  >
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
                    'flex w-full gap-2.5 rounded-[var(--fd-radius-md)] px-2.5 py-2 text-left',
                    item.snippet ? 'items-start' : 'items-center',
                    index === highlight ? 'bg-surface-3' : undefined,
                  )}
                >
                  <span aria-hidden="true" className="shrink-0 text-fg-muted">
                    {renderPaletteIcon(item.icon)}
                  </span>
                  {item.snippet ? (
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="truncate text-[length:var(--fd-text-sm)] text-fg-primary">
                        {item.label}
                      </span>
                      <span className="truncate text-[length:var(--fd-text-xs)] text-fg-muted">
                        {highlightSnippet(item.snippet, item.snippetTokens)}
                      </span>
                    </span>
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-[length:var(--fd-text-sm)] text-fg-primary">
                      {item.label}
                    </span>
                  )}
                  {item.status ? (
                    <span
                      className={cn(
                        'shrink-0 text-[length:var(--fd-text-xs)]',
                        STATUS_TONE_CLASS[item.status.tone],
                      )}
                    >
                      {item.status.label}
                    </span>
                  ) : null}
                  {/* Inside a project scope every row shares the same
                      project, so the per-row label is only repetition. */}
                  {item.sublabel && !activeProject ? (
                    <span className="max-w-[40%] shrink-0 truncate text-[length:var(--fd-text-xs)] text-fg-muted">
                      {item.sublabel}
                    </span>
                  ) : null}
                  {item.time ? (
                    <span className="w-9 shrink-0 text-right text-[length:var(--fd-text-xs)] tabular-nums text-fg-muted">
                      {item.time}
                    </span>
                  ) : null}
                  {item.shortcut?.length ? (
                    <span className="flex shrink-0 items-center gap-0.5">
                      {item.shortcut.map((token, tokenIndex) => (
                        <Kbd key={`${token}-${tokenIndex}`}>{token}</Kbd>
                      ))}
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
            <Kbd>↵</Kbd> {mode === 'new-thread' ? 'create' : 'open'}
          </span>
          {mode === 'new-thread' ? (
            <span className="flex items-center gap-1">
              <Kbd>esc</Kbd> back
            </span>
          ) : null}
          {shortcutHints.keyboardShortcuts?.length ? (
            <span className="ml-auto flex items-center gap-1">
              {shortcutHints.keyboardShortcuts.map((token, index) => (
                <Kbd key={`${token}-${index}`}>{token}</Kbd>
              ))}
              all shortcuts
            </span>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  )
})

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  ChevronDown,
  ChevronUp,
  Columns2,
  PanelBottomClose,
  Plus,
  Rows2,
  Search,
  X,
} from 'lucide-react'
import { createDaemonApiClient, type TerminalSessionInfo } from '@falcondeck/client-core'
import { Button, Kbd, Tooltip, cn } from '@falcondeck/ui'
import { TerminalView, type TerminalViewHandle } from './TerminalView'
import {
  adjacentTabId,
  newPane,
  newTab,
  nextActiveTabId,
  tabIndexForKeyEvent,
  terminalTabLabel,
  type TerminalPaneState,
  type TerminalTab,
} from '../terminal-tabs'
import {
  adjacentPaneId,
  directionalPaneId,
  paneIds,
  paneRects,
  prunePanes,
  removePane,
  setSplitRatio,
  splitDividers,
  splitPane,
  type PaneDirection,
} from '../terminal-layout'
import {
  recallLayout,
  rememberLayout,
  sessionScopeKey,
  type TerminalRequest,
  type TerminalScope,
  type TerminalScopesController,
} from '../terminal-scopes'
import {
  FALLBACK_TERMINAL_COLS,
  FALLBACK_TERMINAL_ROWS,
  TERMINAL_FONT_SIZE,
  measureTerminalGrid,
} from '../terminal-utils'
import { getTerminalFontSize, setTerminalFontSize } from '../terminal-prefs'
import { resolveTerminalPath } from '../terminal-links'
import { prefetchTerminalRuntime } from '../terminal-xterm'
import { commandForEvent, shortcutHintTokens, useShortcutSettings } from '../shortcuts'

export type TerminalOpenFile = (target: {
  path: string
  line: number | null
  column: number | null
}) => void

interface TerminalPanelProps {
  baseUrl: string
  /** Fixed for the life of the instance; one panel exists per scope. */
  scope: TerminalScope | null
  onHide: () => void
  /** The last tab closed. Defaults to `onHide`. */
  onEmpty?: () => void
  /** Keyboard focus was inside the panel when it was hidden. */
  onFocusLeave?: () => void
  onOpenFile?: TerminalOpenFile
  visible?: boolean
  requests?: readonly TerminalRequest[]
  onRequestDone?: (seq: number) => void
}

type CreateMode =
  | { kind: 'tab' }
  | { kind: 'split'; tabId: string; paneId: string; direction: 'row' | 'column' }

const FOCUS_DIRECTION: Partial<Record<string, PaneDirection>> = {
  terminalFocusLeft: 'left',
  terminalFocusRight: 'right',
  terminalFocusUp: 'up',
  terminalFocusDown: 'down',
}

/** Restored sessions in remembered splits; anything new gets its own tab. */
function restoreLayout(scopeKey: string, sessions: TerminalSessionInfo[]) {
  const live = new Set(sessions.map((session) => session.id))
  const remembered = recallLayout(scopeKey)
  const tabs: TerminalTab[] = []
  const placed = new Set<string>()
  for (const tab of remembered?.tabs ?? []) {
    const root = prunePanes(tab.root, live)
    if (!root) continue
    const ids = paneIds(root)
    ids.forEach((id) => placed.add(id))
    tabs.push({
      ...tab,
      root,
      focusedPaneId: ids.includes(tab.focusedPaneId) ? tab.focusedPaneId : ids[0]!,
    })
  }
  for (const session of sessions) {
    if (!placed.has(session.id)) tabs.push(newTab(session))
  }
  const activeTabId =
    remembered?.activeTabId && tabs.some((tab) => tab.id === remembered.activeTabId)
      ? remembered.activeTabId
      : (tabs.at(-1)?.id ?? null)
  return { tabs, activeTabId }
}

export function TerminalPanel({
  baseUrl,
  scope,
  onHide,
  onEmpty,
  onFocusLeave,
  onOpenFile,
  visible = true,
  requests = [],
  onRequestDone,
}: TerminalPanelProps) {
  const api = useMemo(() => createDaemonApiClient(baseUrl), [baseUrl])
  const scopeKey = scope?.key ?? null
  const shortcutSettings = useShortcutSettings()
  const [tabs, setTabs] = useState<TerminalTab[]>([])
  const [panes, setPanes] = useState<Record<string, TerminalPaneState>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(scope === null)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findFound, setFindFound] = useState<boolean | null>(null)
  const [renamingTabId, setRenamingTabId] = useState<string | null>(null)
  // Whether this scope has had its first shell spawned (or requested);
  // state rather than a ref because the placeholder renders from it.
  const [autoCreated, setAutoCreated] = useState(false)
  const tabsRef = useRef<TerminalTab[]>([])
  const panesRef = useRef<Record<string, TerminalPaneState>>({})
  const hostRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLElement | null>(null)
  const findInputRef = useRef<HTMLInputElement | null>(null)
  const viewRefs = useRef(new Map<string, TerminalViewHandle>())
  const scopeRef = useRef(scope)
  const creatingRef = useRef(false)
  const focusTargetRef = useRef<string | null>(null)
  const handledRequestsRef = useRef(new Set<number>())
  const [focusTick, setFocusTick] = useState(0)

  useLayoutEffect(() => {
    scopeRef.current = scope
  }, [scope])

  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])

  useEffect(() => {
    panesRef.current = panes
  }, [panes])

  useEffect(() => {
    void prefetchTerminalRuntime()
  }, [])

  useEffect(() => {
    if (scopeKey && loaded) rememberLayout(scopeKey, { tabs, activeTabId: activeId })
  }, [activeId, loaded, scopeKey, tabs])

  useEffect(() => {
    let cancelled = false
    if (!scope) return
    void (async () => {
      try {
        const { sessions } = await api.listTerminals(scope.workspaceId)
        if (cancelled) return
        const own = sessions.filter((session) => sessionScopeKey(session) === scope.key)
        const restored = restoreLayout(scope.key, own)
        // A tab requested while the list was loading must survive the restore.
        setPanes((current) => ({
          ...Object.fromEntries(own.map((session) => [session.id, newPane(session)])),
          ...current,
        }))
        setTabs((current) => [
          ...restored.tabs.filter(
            (tab) => !current.some((existing) => paneIds(existing.root).some((id) => paneIds(tab.root).includes(id))),
          ),
          ...current,
        ])
        setActiveId((current) => current ?? restored.activeTabId)
        setLoaded(true)
      } catch {
        if (!cancelled) {
          setError('Could not load terminals.')
          setLoaded(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // The scope key is fixed for an instance; workspace follows it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, scopeKey])

  const openSession = useCallback(async (): Promise<TerminalSessionInfo | null> => {
    const current = scopeRef.current
    if (!current || creatingRef.current) return null
    creatingRef.current = true
    setCreating(true)
    setError(null)
    const measured = hostRef.current
      ? measureTerminalGrid(hostRef.current, getTerminalFontSize())
      : { cols: FALLBACK_TERMINAL_COLS, rows: FALLBACK_TERMINAL_ROWS }
    try {
      const { session } = await api.openTerminal(current.workspaceId, {
        ...measured,
        ...(current.threadId ? { thread_id: current.threadId } : {}),
        ...(current.botId ? { bot_id: current.botId } : {}),
      })
      setPanes((existing) =>
        existing[session.id] ? existing : { ...existing, [session.id]: newPane(session) },
      )
      return session
    } catch {
      setError('Could not start a terminal.')
      return null
    } finally {
      creatingRef.current = false
      setCreating(false)
    }
  }, [api])

  const createTerminal = useCallback(
    async (mode: CreateMode = { kind: 'tab' }, focus = true) => {
      if (!scopeRef.current || !loaded) return
      const session = await openSession()
      if (!session) return
      if (mode.kind === 'tab') {
        setTabs((current) =>
          current.some((tab) => paneIds(tab.root).includes(session.id))
            ? current
            : [...current, newTab(session)],
        )
        setActiveId(`tab-${session.id}`)
      } else {
        setTabs((current) =>
          current.map((tab) =>
            tab.id === mode.tabId
              ? {
                  ...tab,
                  root: splitPane(tab.root, mode.paneId, session.id, mode.direction),
                  focusedPaneId: session.id,
                }
              : tab,
          ),
        )
      }
      if (focus) focusTargetRef.current = session.id
    },
    [loaded, openSession],
  )

  // Focus moves only on request: a click, a shortcut, or a tab/split the
  // user just made. The view may not exist yet, so this retries per render.
  void focusTick
  useEffect(() => {
    const target = focusTargetRef.current
    if (!target || !visible) return
    const view = viewRefs.current.get(target)
    if (!view) return
    focusTargetRef.current = null
    view.focus()
  })

  const splitFocused = useCallback(
    (direction: 'row' | 'column') => {
      const tab = tabsRef.current.find((candidate) => candidate.id === activeId)
      if (!tab) return
      void createTerminal({ kind: 'split', tabId: tab.id, paneId: tab.focusedPaneId, direction })
    },
    [activeId, createTerminal],
  )

  const focusPane = useCallback((tabId: string, paneId: string, moveFocus: boolean) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === tabId && tab.focusedPaneId !== paneId ? { ...tab, focusedPaneId: paneId } : tab,
      ),
    )
    if (moveFocus) focusTargetRef.current = paneId
  }, [])

  const finishIfEmpty = useCallback(
    (remaining: TerminalTab[]) => {
      if (remaining.length > 0) return
      // Closing the last tab folds the panel away, and the next ⌘J starts
      // a fresh shell instead of landing on an empty strip.
      setAutoCreated(false)
      ;(onEmpty ?? onHide)()
    },
    [onEmpty, onHide],
  )

  const closeSessions = useCallback(
    (ids: string[]) => {
      for (const id of ids) {
        viewRefs.current.delete(id)
        void api.closeTerminal(id).catch(() => undefined)
      }
      setPanes((current) => {
        const next = { ...current }
        for (const id of ids) delete next[id]
        return next
      })
    },
    [api],
  )

  const closeTab = useCallback(
    (tabId: string) => {
      const tab = tabsRef.current.find((candidate) => candidate.id === tabId)
      if (!tab) return
      const hadFocus = panelHasFocus(panelRef.current)
      const remaining = tabsRef.current.filter((candidate) => candidate.id !== tabId)
      const nextActive = activeId === tabId ? nextActiveTabId(tabsRef.current, tabId) : activeId
      setActiveId(nextActive)
      setTabs(remaining)
      tabsRef.current = remaining
      closeSessions(paneIds(tab.root))
      const nextTab = remaining.find((candidate) => candidate.id === nextActive)
      if (hadFocus && nextTab) focusTargetRef.current = nextTab.focusedPaneId
      finishIfEmpty(remaining)
    },
    [activeId, closeSessions, finishIfEmpty],
  )

  const closePane = useCallback(
    (tabId: string, paneId: string) => {
      const tab = tabsRef.current.find((candidate) => candidate.id === tabId)
      if (!tab) return
      const root = removePane(tab.root, paneId)
      if (!root) {
        closeTab(tabId)
        return
      }
      const hadFocus = panelHasFocus(panelRef.current)
      const focused =
        tab.focusedPaneId === paneId
          ? (adjacentPaneId(tab.root, paneId, -1) ?? paneIds(root)[0]!)
          : tab.focusedPaneId
      const remaining = tabsRef.current.map((candidate) =>
        candidate.id === tabId ? { ...candidate, root, focusedPaneId: focused } : candidate,
      )
      setTabs(remaining)
      tabsRef.current = remaining
      closeSessions([paneId])
      if (hadFocus) focusTargetRef.current = focused
    },
    [closeSessions, closeTab],
  )

  useEffect(() => {
    if (activeId && tabs.some((tab) => tab.id === activeId)) return
    const fallback = tabs.at(-1)?.id ?? null
    if (fallback !== activeId) setActiveId(fallback)
  }, [activeId, tabs])

  // Auto-start the first shell when the panel opens on an empty scope. It
  // does not take focus: the open request (⌘J) says whether it should.
  const pendingCreate = requests.some((entry) => entry.kind === 'create')
  useEffect(() => {
    if (!visible || !loaded || !scope || error || autoCreated) return
    if (pendingCreate || tabs.length > 0 || creating) return
    setAutoCreated(true)
    void createTerminal({ kind: 'tab' }, false)
  }, [autoCreated, createTerminal, creating, error, loaded, pendingCreate, scope, tabs.length, visible])

  useEffect(() => {
    const done = (seq: number) => {
      handledRequestsRef.current.add(seq)
      onRequestDone?.(seq)
    }
    for (const entry of requests) {
      if (handledRequestsRef.current.has(entry.seq)) continue
      if (entry.kind === 'find') {
        done(entry.seq)
        setFindOpen(true)
        requestAnimationFrame(() => {
          findInputRef.current?.focus()
          findInputRef.current?.select()
        })
      } else if (entry.kind === 'create') {
        // Wait for this scope's list and any current spawn so neither can
        // swallow the requested tab.
        if (!loaded || creating) continue
        done(entry.seq)
        setAutoCreated(true)
        void createTerminal({ kind: 'tab' }, true)
      } else if (entry.kind === 'focus') {
        if (!loaded) continue
        const tab = tabs.find((candidate) => candidate.id === activeId)
        if (!tab) {
          if (creating || pendingCreate || (!autoCreated && !error)) continue
          done(entry.seq)
          continue
        }
        done(entry.seq)
        focusTargetRef.current = tab.focusedPaneId
        // Re-render so the focus effect sees the target.
        setFocusTick((tick) => tick + 1)
      }
    }
  }, [activeId, autoCreated, createTerminal, creating, error, loaded, onRequestDone, pendingCreate, requests, tabs])

  // Hiding a focused panel must not leave keystrokes or dictation flowing
  // into an invisible shell.
  useLayoutEffect(() => {
    if (visible) return
    const panel = panelRef.current
    const active = document.activeElement
    if (panel && active instanceof HTMLElement && panel.contains(active)) {
      active.blur()
      onFocusLeave?.()
    }
  }, [onFocusLeave, visible])

  const updatePane = useCallback((paneId: string, patch: Partial<TerminalPaneState>) => {
    setPanes((current) => {
      const pane = current[paneId]
      if (!pane) return current
      const changed = (Object.keys(patch) as (keyof TerminalPaneState)[]).some(
        (key) => pane[key] !== patch[key],
      )
      return changed ? { ...current, [paneId]: { ...pane, ...patch } } : current
    })
  }, [])

  const handleExited = useCallback(
    (paneId: string) => updatePane(paneId, { status: 'exited' }),
    [updatePane],
  )

  const handleTitleChange = useCallback(
    (paneId: string, title: string) => {
      const normalized = title.trim()
      if (normalized) updatePane(paneId, { observedTitle: normalized })
    },
    [updatePane],
  )

  const handleStatus = useCallback(
    (paneId: string, status: { process: string | null; cwd: string | null }) => {
      const pane = panesRef.current[paneId]
      if (!pane) return
      const shell = (pane.session.shell.split('/').at(-1) ?? '').replace(/^-/, '')
      const backAtShell = status.process?.replace(/^-/, '') === shell
      // A program's OSC title outlives it; drop it once the shell is back.
      updatePane(paneId, {
        process: status.process,
        cwd: status.cwd,
        ...(backAtShell ? { observedTitle: null } : {}),
      })
    },
    [updatePane],
  )

  const handleOpenFile = useCallback(
    (paneId: string, link: { path: string; line: number | null; column: number | null }) => {
      const pane = panesRef.current[paneId]
      if (!pane || !onOpenFile) return
      const cwd = pane.cwd ?? pane.session.cwd
      const home = /^\/Users\/[^/]+/.exec(pane.session.cwd)?.[0] ?? null
      onOpenFile({ ...link, path: resolveTerminalPath(link.path, cwd, home) })
    },
    [onOpenFile],
  )

  const cycleTab = useCallback(
    (offset: -1 | 1) => {
      const next = adjacentTabId(tabsRef.current, activeId, offset)
      if (!next) return
      setActiveId(next)
      const tab = tabsRef.current.find((candidate) => candidate.id === next)
      if (tab) focusTargetRef.current = tab.focusedPaneId
    },
    [activeId],
  )

  const selectTab = useCallback((tabId: string, moveFocus: boolean) => {
    setActiveId(tabId)
    const tab = tabsRef.current.find((candidate) => candidate.id === tabId)
    if (tab && moveFocus) focusTargetRef.current = tab.focusedPaneId
  }, [])

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? null
  const activePaneId = activeTab?.focusedPaneId ?? null

  const runFind = useCallback(
    (backwards = false) => {
      const activeView = activePaneId ? viewRefs.current.get(activePaneId) : undefined
      if (!findQuery || !activeView) {
        setFindFound(findQuery ? false : null)
        return
      }
      const found = backwards ? activeView.findPrevious(findQuery) : activeView.findNext(findQuery)
      setFindFound(found)
    },
    [activePaneId, findQuery],
  )

  const closeFind = useCallback(() => {
    const activeView = activePaneId ? viewRefs.current.get(activePaneId) : undefined
    setFindOpen(false)
    setFindFound(null)
    activeView?.clearSearch()
    activeView?.focus()
  }, [activePaneId])

  useEffect(() => {
    if (!visible) return
    function handleKey(event: KeyboardEvent) {
      if (event.repeat && !/^Arrow/.test(event.key)) return
      const target = event.target
      const inPanel = target instanceof Node && panelRef.current?.contains(target)
      if (!inPanel) return
      const handled = () => {
        event.preventDefault()
        event.stopPropagation()
      }
      const jumpIndex = tabIndexForKeyEvent(event, tabsRef.current.length)
      if (jumpIndex !== null) {
        handled()
        const tab = tabsRef.current[jumpIndex]
        if (tab) selectTab(tab.id, true)
        return
      }
      const command = commandForEvent('terminal', event, shortcutSettings)
      if (!command) return
      const tab = tabsRef.current.find((candidate) => candidate.id === activeId)
      const paneCount = tab ? paneIds(tab.root).length : 0
      // With one pane, ⌘[ / ⌘] keep their chat-history meaning.
      if ((command === 'terminalNextPane' || command === 'terminalPreviousPane') && paneCount < 2) {
        return
      }
      // ⌘W is also the native Close Window accelerator; preventDefault here
      // keeps WKWebView from forwarding it to the menu.
      handled()
      if (event.repeat && !FOCUS_DIRECTION[command]) return
      switch (command) {
        case 'terminalNewTab':
          void createTerminal()
          break
        case 'terminalCloseTab':
          if (tab) closePane(tab.id, tab.focusedPaneId)
          break
        case 'terminalNextTab':
          cycleTab(1)
          break
        case 'terminalPreviousTab':
          cycleTab(-1)
          break
        case 'terminalSplitRight':
          splitFocused('row')
          break
        case 'terminalSplitDown':
          splitFocused('column')
          break
        case 'terminalNextPane':
        case 'terminalPreviousPane': {
          if (!tab) break
          const next = adjacentPaneId(tab.root, tab.focusedPaneId, command === 'terminalNextPane' ? 1 : -1)
          if (next) focusPane(tab.id, next, true)
          break
        }
        case 'terminalFocusLeft':
        case 'terminalFocusRight':
        case 'terminalFocusUp':
        case 'terminalFocusDown': {
          const direction = FOCUS_DIRECTION[command]
          if (!tab || !direction) break
          const next = directionalPaneId(tab.root, tab.focusedPaneId, direction)
          if (next) focusPane(tab.id, next, true)
          break
        }
        case 'terminalZoomIn':
          setTerminalFontSize(getTerminalFontSize() + 1)
          break
        case 'terminalZoomOut':
          setTerminalFontSize(getTerminalFontSize() - 1)
          break
        case 'terminalZoomReset':
          setTerminalFontSize(TERMINAL_FONT_SIZE)
          break
        default:
          break
      }
    }
    // Capture phase: runs before xterm's own key handling and before the
    // app-wide shortcuts, which never see a key the terminal consumed.
    window.addEventListener('keydown', handleKey, true)
    return () => window.removeEventListener('keydown', handleKey, true)
  }, [activeId, closePane, createTerminal, cycleTab, focusPane, selectTab, shortcutSettings, splitFocused, visible])

  const renameTab = useCallback((tabId: string, title: string | null) => {
    setTabs((current) =>
      current.map((tab) => (tab.id === tabId ? { ...tab, customTitle: title?.trim() || null } : tab)),
    )
    setRenamingTabId(null)
  }, [])

  const anyPanes = tabs.length > 0

  const registerView = useCallback((paneId: string, handle: TerminalViewHandle | null) => {
    if (handle) viewRefs.current.set(paneId, handle)
    else viewRefs.current.delete(paneId)
  }, [])

  return (
    <section
      ref={panelRef}
      aria-label="Terminal"
      data-terminal-panel=""
      data-terminal-scope={scopeKey ?? undefined}
      className="flex h-full min-h-0 flex-col bg-surface-0"
    >
      <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border-subtle px-2">
        <span className="ml-1 text-[11px] font-medium uppercase tracking-wide text-fg-muted">
          Terminal
        </span>
        <div
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          data-terminal-tabs=""
        >
          {tabs.map((tab) => {
            const isActive = tab.id === activeId
            const label = terminalTabLabel(tab, panes)
            const ids = paneIds(tab.root)
            const exited = ids.every((id) => panes[id]?.status === 'exited')
            return (
              <div key={tab.id} data-terminal-tab="" className="flex items-center">
                {renamingTabId === tab.id ? (
                  <input
                    autoFocus
                    aria-label="Tab name"
                    defaultValue={tab.customTitle ?? label}
                    data-terminal-tab-rename=""
                    onBlur={(event) => renameTab(tab.id, event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        renameTab(tab.id, event.currentTarget.value)
                        focusTargetRef.current = tab.focusedPaneId
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        setRenamingTabId(null)
                      }
                    }}
                    className="h-6 w-32 rounded-md border border-border-default bg-surface-1 px-1.5 text-xs text-fg-primary outline-none"
                  />
                ) : (
                  <button
                    type="button"
                    data-active={isActive || undefined}
                    data-status={exited ? 'exited' : 'running'}
                    title="Double-click to rename"
                    onClick={() => selectTab(tab.id, true)}
                    onDoubleClick={() => setRenamingTabId(tab.id)}
                    className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-fg-tertiary hover:bg-surface-2 data-[active=true]:bg-surface-2 data-[active=true]:text-fg-primary"
                  >
                    <span
                      aria-hidden="true"
                      className={cn('h-1.5 w-1.5 rounded-full', exited ? 'bg-fg-muted' : 'bg-accent')}
                    />
                    <span className="max-w-40 truncate">{label}</span>
                    {ids.length > 1 ? (
                      <span className="text-[10px] text-fg-muted">{ids.length}</span>
                    ) : null}
                    {exited ? <span className="text-[10px] text-fg-muted">exited</span> : null}
                  </button>
                )}
                <button
                  type="button"
                  aria-label={`Close ${label}`}
                  data-terminal-tab-close=""
                  onClick={() => closeTab(tab.id)}
                  className="rounded p-0.5 text-fg-muted hover:bg-surface-2 hover:text-fg-primary"
                >
                  <X aria-hidden="true" className="h-3 w-3" />
                </button>
              </div>
            )
          })}
        </div>
        <Tooltip label="Find in terminal">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Find in terminal"
            onClick={() => {
              setFindOpen(true)
              requestAnimationFrame(() => findInputRef.current?.focus())
            }}
          >
            <Search aria-hidden="true" className="h-4 w-4" />
          </Button>
        </Tooltip>
        <Tooltip
          label="Split right"
          shortcut={shortcutHintTokens('terminalSplitRight', shortcutSettings)}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Split right"
            disabled={!activeTab || creating}
            onClick={() => splitFocused('row')}
          >
            <Columns2 aria-hidden="true" className="h-4 w-4" />
          </Button>
        </Tooltip>
        <Tooltip
          label="Split down"
          shortcut={shortcutHintTokens('terminalSplitDown', shortcutSettings)}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Split down"
            disabled={!activeTab || creating}
            onClick={() => splitFocused('column')}
          >
            <Rows2 aria-hidden="true" className="h-4 w-4" />
          </Button>
        </Tooltip>
        <Tooltip
          label="New terminal"
          shortcut={shortcutHintTokens('terminalNewTab', shortcutSettings)}
        >
          <button
            type="button"
            aria-label="New terminal"
            data-terminal-new=""
            onClick={() => void createTerminal()}
            disabled={!scope || !loaded || creating}
            className="rounded p-1 text-fg-muted hover:bg-surface-2 hover:text-fg-primary disabled:opacity-40"
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
          </button>
        </Tooltip>
        <Tooltip
          label="Hide terminal"
          shortcut={shortcutHintTokens('toggleTerminal', shortcutSettings)}
        >
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Hide terminal"
            onClick={onHide}
          >
            <PanelBottomClose aria-hidden="true" className="h-4 w-4" />
          </Button>
        </Tooltip>
      </div>
      {findOpen ? (
        <div
          role="search"
          aria-label="Find in terminal"
          className="flex items-center gap-1 border-b border-border-subtle bg-surface-2 px-2 py-1"
          onKeyDown={(event) => {
            // Only the keys the find bar consumes stop here; ⌘T, ⌘W and the
            // other panel shortcuts still reach the window handler.
            if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              closeFind()
            } else if (event.key === 'Enter') {
              event.preventDefault()
              event.stopPropagation()
              runFind(event.shiftKey)
            }
          }}
        >
          <label className="fd-focus-within flex min-w-0 flex-1 items-center gap-2 rounded-[var(--fd-radius-md)] border border-border-default bg-surface-1 px-2">
            <Search className="h-3.5 w-3.5 text-fg-muted" aria-hidden="true" />
            <input
              ref={findInputRef}
              value={findQuery}
              onChange={(event) => {
                setFindQuery(event.target.value)
                setFindFound(null)
              }}
              placeholder="Find in terminal"
              aria-label="Find text"
              className="h-7 min-w-0 flex-1 bg-transparent text-[length:var(--fd-text-sm)] text-fg-primary outline-none placeholder:text-fg-muted"
            />
            {findFound === false ? (
              <span className="text-[length:var(--fd-text-2xs)] text-danger">No match</span>
            ) : null}
          </label>
          <button
            type="button"
            className="fd-focus rounded p-1 text-fg-muted hover:bg-surface-3 hover:text-fg-primary"
            aria-label="Previous match"
            onClick={() => runFind(true)}
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="fd-focus rounded p-1 text-fg-muted hover:bg-surface-3 hover:text-fg-primary"
            aria-label="Next match"
            onClick={() => runFind(false)}
          >
            <ChevronDown className="h-4 w-4" />
          </button>
          <button
            type="button"
            className="fd-focus rounded p-1 text-fg-muted hover:bg-surface-3 hover:text-fg-primary"
            aria-label="Close find"
            onClick={closeFind}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}
      <div ref={hostRef} className="relative min-h-0 flex-1 overflow-hidden">
        {!scope ? (
          <div className="flex h-full items-center justify-center text-sm text-fg-muted">
            Select a project to open a terminal.
          </div>
        ) : error && !anyPanes ? (
          <div className="flex h-full items-center justify-center text-sm text-danger">{error}</div>
        ) : anyPanes ? (
          tabs.map((tab) => {
            const isActive = tab.id === activeId
            return (
              <TabPanes
                key={tab.id}
                tab={tab}
                panes={panes}
                active={isActive}
                visible={visible}
                socketUrl={api.terminalSocketUrl}
                registerView={registerView}
                onFocusPane={(paneId) => focusPane(tab.id, paneId, false)}
                onResizeSplit={(splitId, ratio) =>
                  setTabs((current) =>
                    current.map((candidate) =>
                      candidate.id === tab.id
                        ? { ...candidate, root: setSplitRatio(candidate.root, splitId, ratio) }
                        : candidate,
                    ),
                  )
                }
                onExited={handleExited}
                onTitleChange={handleTitleChange}
                onStatus={handleStatus}
                onOpenFile={handleOpenFile}
              />
            )
          })
        ) : !loaded || creating || !autoCreated ? (
          <div
            role="status"
            className="flex h-full items-center justify-center gap-2 text-sm text-fg-muted"
          >
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-fg-muted"
            />
            Starting terminal…
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-fg-muted">
            <span>No open terminals</span>
            <span className="flex items-center gap-1.5 text-[length:var(--fd-text-xs)]">
              Press
              {(shortcutHintTokens('terminalNewTab', shortcutSettings) ?? ['⌘', 'T']).map(
                (token, index) => (
                  <Kbd key={`${token}-${index}`}>{token}</Kbd>
                ),
              )}
              to start one
            </span>
          </div>
        )}
      </div>
    </section>
  )
}

function panelHasFocus(panel: HTMLElement | null) {
  return Boolean(panel && document.activeElement && panel.contains(document.activeElement))
}

const percent = (value: number) => `${value * 100}%`

interface TabPanesProps {
  tab: TerminalTab
  panes: Record<string, TerminalPaneState>
  active: boolean
  visible: boolean
  socketUrl: (id: string) => string
  registerView: (paneId: string, handle: TerminalViewHandle | null) => void
  onFocusPane: (paneId: string) => void
  onResizeSplit: (splitId: string, ratio: number) => void
  onExited: (paneId: string) => void
  onTitleChange: (paneId: string, title: string) => void
  onStatus: (paneId: string, status: { process: string | null; cwd: string | null }) => void
  onOpenFile: (
    paneId: string,
    link: { path: string; line: number | null; column: number | null },
  ) => void
}

/**
 * One tab's panes, absolutely positioned from the split tree. Panes render
 * flat and keyed by session so splitting or closing a neighbour never
 * remounts a running terminal.
 */
function TabPanes({
  tab,
  panes,
  active,
  visible,
  socketUrl,
  registerView,
  onFocusPane,
  onResizeSplit,
  onExited,
  onTitleChange,
  onStatus,
  onOpenFile,
}: TabPanesProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const rects = paneRects(tab.root)
  const dividers = splitDividers(tab.root)
  const split = rects.size > 1

  const startDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    divider: (typeof dividers)[number],
  ) => {
    const container = containerRef.current
    if (!container) return
    event.preventDefault()
    const handle = event.currentTarget
    handle.setPointerCapture(event.pointerId)
    const bounds = container.getBoundingClientRect()
    const move = (moveEvent: PointerEvent) => {
      const ratio =
        divider.direction === 'row'
          ? (moveEvent.clientX - bounds.left - divider.rect.x * bounds.width) /
            (divider.rect.w * bounds.width)
          : (moveEvent.clientY - bounds.top - divider.rect.y * bounds.height) /
            (divider.rect.h * bounds.height)
      if (Number.isFinite(ratio)) onResizeSplit(divider.id, ratio)
    }
    const end = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  return (
    <div
      ref={containerRef}
      data-terminal-tab-panes={tab.id}
      className={cn(
        'h-full w-full',
        active ? 'relative z-[1]' : 'invisible absolute inset-0 pointer-events-none',
      )}
      inert={!active}
      aria-hidden={active ? undefined : true}
    >
      {[...rects].map(([paneId, rect]) => {
        const pane = panes[paneId]
        if (!pane) return null
        const focused = paneId === tab.focusedPaneId
        return (
          <div
            key={paneId}
            data-terminal-pane={paneId}
            data-focused={focused || undefined}
            onFocusCapture={() => onFocusPane(paneId)}
            onMouseDown={() => onFocusPane(paneId)}
            className={cn(
              'absolute overflow-hidden',
              split && rect.x > 0 && 'border-l border-border-subtle',
              split && rect.y > 0 && 'border-t border-border-subtle',
              split && !focused && 'opacity-70',
            )}
            style={{
              left: percent(rect.x),
              top: percent(rect.y),
              width: percent(rect.w),
              height: percent(rect.h),
            }}
          >
            <TerminalView
              ref={(handle) => registerView(paneId, handle)}
              session={pane.session}
              active={active && visible}
              socketUrl={socketUrl(paneId)}
              onExited={() => onExited(paneId)}
              onTitleChange={(title) => onTitleChange(paneId, title)}
              onStatus={(status) => onStatus(paneId, status)}
              onOpenFile={(link) => onOpenFile(paneId, link)}
            />
          </div>
        )
      })}
      {dividers.map((divider) => {
        const row = divider.direction === 'row'
        const at = row
          ? divider.rect.x + divider.rect.w * divider.ratio
          : divider.rect.y + divider.rect.h * divider.ratio
        return (
          <div
            key={divider.id}
            role="separator"
            aria-orientation={row ? 'vertical' : 'horizontal'}
            data-terminal-divider={divider.id}
            onPointerDown={(event) => startDrag(event, divider)}
            className={cn(
              'absolute z-[2] hover:bg-border-default',
              row ? '-ml-[3px] w-[6px] cursor-col-resize' : '-mt-[3px] h-[6px] cursor-row-resize',
            )}
            style={
              row
                ? { left: percent(at), top: percent(divider.rect.y), height: percent(divider.rect.h) }
                : { top: percent(at), left: percent(divider.rect.x), width: percent(divider.rect.w) }
            }
          />
        )
      })}
    </div>
  )
}

/**
 * Every retained scope keeps its own panel (and live xterm instances); only
 * the selected one is shown. Switching bots therefore swaps panels instead of
 * reloading one, so scrollback, splits and running programs stay put.
 */
export function TerminalDock({
  baseUrl,
  controller,
  onFocusLeave,
  onOpenFile,
}: {
  baseUrl: string
  controller: TerminalScopesController
  onFocusLeave?: () => void
  onOpenFile?: TerminalOpenFile
}) {
  const { current, isOpen, retained, requests, hide, release, completeRequest } = controller
  const requestsByScope = useMemo(() => {
    const map = new Map<string, TerminalRequest[]>()
    for (const entry of requests) {
      map.set(entry.scopeKey, [...(map.get(entry.scopeKey) ?? []), entry])
    }
    return map
  }, [requests])
  return (
    <>
      {retained.map((scope) => {
        const isCurrent = scope.key === current?.key
        return (
          <div
            key={scope.key}
            data-terminal-scope-host={scope.key}
            className={isCurrent ? 'h-full' : 'hidden'}
            inert={!isCurrent}
            aria-hidden={isCurrent ? undefined : true}
          >
            <TerminalPanel
              baseUrl={baseUrl}
              scope={isCurrent && current ? current : scope}
              visible={isCurrent && isOpen}
              requests={requestsByScope.get(scope.key) ?? EMPTY_REQUESTS}
              onRequestDone={completeRequest}
              onHide={() => hide(scope.key)}
              onEmpty={() => release(scope.key)}
              onFocusLeave={onFocusLeave}
              onOpenFile={onOpenFile}
            />
          </div>
        )
      })}
    </>
  )
}

const EMPTY_REQUESTS: readonly TerminalRequest[] = []

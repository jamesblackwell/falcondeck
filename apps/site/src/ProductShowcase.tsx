import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'

import {
  Activity,
  Blocks,
  Braces,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileJson,
  FileText,
  Folder,
  FolderClosed,
  FolderOpen,
  GitBranch,
  Laptop,
  Mic,
  PanelLeft,
  PanelRight,
  Pin,
  Plus,
  Search,
  Send,
  SlidersHorizontal,
} from 'lucide-react'

/* A scripted, looping session: someone asks for a change on the Mac, the agent
   works through it, the phone follows along, then replies from the phone. Every
   view is a pure function of one clock, so the two devices cannot drift apart;
   the other device simply sees each event SYNC_LAG later. */

type Device = 'desktop' | 'phone'
type FileStatus = 'A' | 'M'
type Tool = { at: number; verb: string; target: string; change?: FileStatus }

const TYPE_MS = 48
const SYNC_LAG = 380
const WORD_MS = 70

const PROJECT = 'storefront'
const THREAD_TITLE = 'Login rate limiting'
const PROMPT_1 = 'Add rate limiting to the login route'
const PROMPT_2 = 'Add a test for the 429 case'
const REPLY_1 =
  'Added a sliding-window limiter to the login route: five attempts per minute per IP, then a 429 with Retry-After. All 23 tests pass.'
const REPLY_2 = 'Added a test that trips the limit and checks the 429. All 24 tests pass.'

const DESKTOP_TYPE_AT = 700
const SEND_1 = DESKTOP_TYPE_AT + PROMPT_1.length * TYPE_MS + 400
const PHONE_TYPE_AT = 11_000
const SEND_2 = PHONE_TYPE_AT + PROMPT_2.length * TYPE_MS + 400
const BACKGROUND_DONE = 9_600
const LOOP_MS = 21_500
const FADE_MS = 450
/* The settled frame shown before hydration and to reduced-motion visitors. */
const FINAL_FRAME = 18_500

type Item =
  | { id: string; kind: 'user'; text: string; at: number; from: Device }
  | { id: string; kind: 'work'; at: number; done: number; seconds: number; tools: Tool[]; diff: [number, number] }
  | { id: string; kind: 'agent'; text: string; at: number }

const ITEMS: Item[] = [
  { id: 'u1', kind: 'user', text: PROMPT_1, at: SEND_1, from: 'desktop' },
  {
    id: 'w1',
    kind: 'work',
    at: SEND_1 + 500,
    done: SEND_1 + 5_000,
    seconds: 41,
    diff: [38, 4],
    tools: [
      { at: SEND_1 + 500, verb: 'Read', target: 'src/routes/auth.ts' },
      { at: SEND_1 + 1_500, verb: 'Edit', target: 'src/middleware/rateLimit.ts', change: 'A' },
      { at: SEND_1 + 2_600, verb: 'Edit', target: 'src/routes/auth.ts', change: 'M' },
      { at: SEND_1 + 3_600, verb: 'Run', target: 'npm test' },
    ],
  },
  { id: 'a1', kind: 'agent', text: REPLY_1, at: SEND_1 + 5_100 },
  { id: 'u2', kind: 'user', text: PROMPT_2, at: SEND_2, from: 'phone' },
  {
    id: 'w2',
    kind: 'work',
    at: SEND_2 + 900,
    done: SEND_2 + 3_600,
    seconds: 18,
    diff: [21, 0],
    tools: [
      { at: SEND_2 + 900, verb: 'Edit', target: 'tests/auth.test.ts', change: 'A' },
      { at: SEND_2 + 2_100, verb: 'Run', target: 'npm test' },
    ],
  },
  { id: 'a2', kind: 'agent', text: REPLY_2, at: SEND_2 + 3_700 },
]

const SYNC_EVENTS = [SEND_1, SEND_2]
const DAEMON: Device = 'desktop'

function origin(item: Item): Device {
  return item.kind === 'user' ? item.from : DAEMON
}

/** When `device` sees something that happened at `at` on `from`. */
function seenAt(at: number, from: Device, device: Device) {
  return from === device ? at : at + SYNC_LAG
}

function typed(text: string, start: number, end: number, t: number) {
  if (t < start || t >= end) return ''
  return text.slice(0, Math.floor((t - start) / TYPE_MS) + 1)
}

function streamed(text: string, start: number, t: number) {
  const words = text.split(' ')
  return words.slice(0, Math.floor((t - start) / WORD_MS) + 1).join(' ')
}

function visibleItems(t: number, device: Device) {
  return ITEMS.filter((item) => t >= seenAt(item.at, origin(item), device))
}

function isWorking(t: number, device: Device) {
  return ITEMS.some(
    (item) =>
      item.kind === 'work' && t >= seenAt(item.at, DAEMON, device) && t < seenAt(item.done, DAEMON, device),
  )
}

function changedFiles(t: number) {
  const changed = new Map<string, { status: FileStatus; at: number }>()
  for (const item of ITEMS) {
    if (item.kind !== 'work') continue
    for (const tool of item.tools) {
      const at = tool.at + 300
      if (tool.change && t >= at && !changed.has(tool.target)) changed.set(tool.target, { status: tool.change, at })
    }
  }
  return changed
}

function useShowcaseClock() {
  const [t, setT] = useState(FINAL_FRAME)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const node = ref.current
    // Dev-only: `?showcase-t=5000` freezes the scene on one frame for visual QA.
    const frozen = import.meta.env.DEV ? new URLSearchParams(window.location.search).get('showcase-t') : null
    if (frozen !== null) return setT(Number(frozen))
    if (!node || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

    let inView = false
    let timer: number | undefined
    // Begin on the fade-out so the prerendered final frame dissolves into the loop.
    let clock = LOOP_MS - FADE_MS
    let last = 0

    const tick = () => {
      const now = performance.now()
      clock = (clock + Math.min(now - last, 100)) % LOOP_MS
      last = now
      setT(clock)
    }
    const sync = () => {
      const run = inView && document.visibilityState === 'visible'
      if (run && timer === undefined) {
        last = performance.now()
        timer = window.setInterval(tick, 40)
      } else if (!run && timer !== undefined) {
        window.clearInterval(timer)
        timer = undefined
      }
    }
    const observer = new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting
      sync()
    })
    observer.observe(node)
    document.addEventListener('visibilitychange', sync)
    return () => {
      observer.disconnect()
      document.removeEventListener('visibilitychange', sync)
      if (timer !== undefined) window.clearInterval(timer)
    }
  }, [])

  return { t, ref }
}

/* Shared pieces --------------------------------------------------------------- */

function Diamond({ outline }: { outline?: boolean }) {
  return (
    <span className={outline ? 'mock-diamond mock-diamond--outline' : 'mock-diamond'} aria-hidden="true">
      <span />
    </span>
  )
}

function ClaudeMark() {
  return <span className="mock-claude">✳</span>
}

/** Fills from the top and follows the tail once it overflows, like the app. */
function Viewport({ className, children }: { className: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = ref.current
    if (!node) return
    node.scrollTop = node.scrollHeight
    node.toggleAttribute('data-scrolled', node.scrollTop > 0)
  })
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  )
}

function Transcript({ t, device }: { t: number; device: Device }) {
  return (
    <>
      {visibleItems(t, device).map((item) => {
        const localT = t - (origin(item) === device ? 0 : SYNC_LAG)
        if (item.kind === 'user') {
          return (
            <div key={item.id} className="mock-user mock-enter">
              {item.text}
            </div>
          )
        }
        if (item.kind === 'agent') {
          return (
            <p key={item.id} className="mock-agent">
              {streamed(item.text, item.at, localT)}
            </p>
          )
        }
        return <WorkRow key={item.id} item={item} t={localT} />
      })}
    </>
  )
}

function WorkRow({ item, t }: { item: Extract<Item, { kind: 'work' }>; t: number }) {
  if (t < item.done) {
    const tool = [...item.tools].reverse().find((candidate) => t >= candidate.at) ?? item.tools[0]
    return (
      <div className="mock-work mock-work--live mock-enter">
        <Diamond />
        <span>Working…</span>
        <code key={tool.at} className="mock-work__tool">
          {tool.verb} {tool.target.split('/').pop()}
        </code>
      </div>
    )
  }
  return (
    <div className="mock-work">
      <span>Worked for {item.seconds}s</span>
      <ChevronRight aria-hidden="true" />
      <span className="mock-work__diff">
        <span className="mock-diff mock-diff--add">+{item.diff[0]}</span>
        {item.diff[1] > 0 && <span className="mock-diff mock-diff--del">−{item.diff[1]}</span>}
      </span>
    </div>
  )
}

/* Desktop ----------------------------------------------------------------------- */

function SidebarThread({
  title,
  time,
  marker,
  active,
  enter,
}: {
  title: string
  time: string
  marker?: ReactNode
  active?: boolean
  enter?: boolean
}) {
  const className = ['mock-thread', active && 'mock-thread--active', enter && 'mock-enter'].filter(Boolean).join(' ')
  return (
    <div className={className}>
      <span className="mock-thread__marker">{marker}</span>
      <span className="mock-thread__title">{title}</span>
      <span className="mock-thread__time">{time}</span>
    </div>
  )
}

function DesktopSidebar({ t }: { t: number }) {
  const started = t >= SEND_1
  return (
    <aside className="mock-sidebar">
      <div className="mock-sidebar__chrome">
        <span className="mock-lights" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <Search aria-hidden="true" />
      </div>

      <div className="mock-nav mock-nav--new">
        <span className="mock-nav__plus">
          <Plus aria-hidden="true" />
        </span>
        <span>New chat</span>
        <kbd>⇧⌘N</kbd>
      </div>
      <div className="mock-nav">
        <Activity aria-hidden="true" />
        <span>Activity</span>
      </div>
      <div className="mock-nav">
        <Blocks aria-hidden="true" />
        <span>Extensions</span>
        <small>2</small>
      </div>
      <div className="mock-nav">
        <CalendarClock aria-hidden="true" />
        <span>Automations</span>
      </div>

      <p className="mock-heading">Pinned</p>
      <SidebarThread title="Launch checklist" time="2d" marker={<Pin className="mock-pin" aria-hidden="true" />} />

      <p className="mock-heading">Projects</p>
      <div className="mock-project">
        <FolderOpen aria-hidden="true" />
        <span>{PROJECT}</span>
      </div>
      <div className="mock-project__threads">
        {started && (
          <SidebarThread
            title={THREAD_TITLE}
            time="now"
            marker={isWorking(t, 'desktop') ? <Diamond /> : null}
            active
            enter
          />
        )}
        <SidebarThread
          title="Fix checkout totals"
          time={t < BACKGROUND_DONE ? '3m' : 'now'}
          marker={t < BACKGROUND_DONE ? <Diamond /> : <span className="mock-unread" />}
        />
        <SidebarThread title="Product search filters" time="1h" />
        {!started && <SidebarThread title="Upgrade payments SDK" time="5h" />}
      </div>
      <div className="mock-project">
        <FolderClosed aria-hidden="true" />
        <span>docs-site</span>
      </div>

      <div className="mock-sidebar__footer">
        <SlidersHorizontal aria-hidden="true" />
        <span>Options</span>
      </div>
    </aside>
  )
}

function Composer({ t }: { t: number }) {
  const draft = typed(PROMPT_1, DESKTOP_TYPE_AT, SEND_1, t)
  const isNew = t < SEND_1
  const sending = t >= SEND_1 - 220 && t < SEND_1 + 120
  return (
    <div className="mock-composer-wrap">
      {isNew && (
        <div className="mock-context">
          <span>
            <Folder aria-hidden="true" />
            {PROJECT}
          </span>
          <span>
            <Laptop aria-hidden="true" />
            Local
          </span>
          <span>
            <GitBranch aria-hidden="true" />
            main
          </span>
        </div>
      )}
      <div className="mock-composer">
        <div className={draft ? 'mock-composer__input' : 'mock-composer__input mock-composer__input--empty'}>
          {draft || 'Ask Claude anything…'}
          {draft && <span className="mock-caret" />}
        </div>
        <div className="mock-composer__footer">
          <Plus aria-hidden="true" />
          <span className="mock-select">
            <ClaudeMark />
            Claude
            <ChevronDown aria-hidden="true" />
          </span>
          <span className="mock-select">
            Bypass
            <ChevronDown aria-hidden="true" />
          </span>
          <span className="mock-select">
            opus 5.5 <em>Medium</em>
            <ChevronDown aria-hidden="true" />
          </span>
          <Mic className="mock-composer__mic" aria-hidden="true" />
          <span className={sending ? 'mock-send mock-send--pressed' : 'mock-send'}>
            <Send aria-hidden="true" />
          </span>
        </div>
      </div>
    </div>
  )
}

type TreeRow = { name: string; depth: number; folder?: 'open' | 'closed'; path?: string }

const TREE: TreeRow[] = [
  { name: '.github', depth: 0, folder: 'closed' },
  { name: 'src', depth: 0, folder: 'open' },
  { name: 'middleware', depth: 1, folder: 'open' },
  { name: 'rateLimit.ts', depth: 2, path: 'src/middleware/rateLimit.ts' },
  { name: 'session.ts', depth: 2, path: 'src/middleware/session.ts' },
  { name: 'routes', depth: 1, folder: 'open' },
  { name: 'auth.ts', depth: 2, path: 'src/routes/auth.ts' },
  { name: 'cart.ts', depth: 2, path: 'src/routes/cart.ts' },
  { name: 'server.ts', depth: 1, path: 'src/server.ts' },
  { name: 'tests', depth: 0, folder: 'open' },
  { name: 'auth.test.ts', depth: 1, path: 'tests/auth.test.ts' },
  { name: 'cart.test.ts', depth: 1, path: 'tests/cart.test.ts' },
  { name: 'package.json', depth: 0, path: 'package.json' },
  { name: 'README.md', depth: 0, path: 'README.md' },
  { name: 'tsconfig.json', depth: 0, path: 'tsconfig.json' },
]

/* Files the agent creates are absent from the tree until they exist. */
const CREATED = new Set(
  ITEMS.flatMap((item) => (item.kind === 'work' ? item.tools : []))
    .filter((tool) => tool.change === 'A')
    .map((tool) => tool.target),
)

function FileIcon({ name }: { name: string }) {
  if (name.endsWith('.ts')) return <Braces className="mock-file-icon mock-file-icon--ts" aria-hidden="true" />
  if (name.endsWith('.json')) return <FileJson className="mock-file-icon mock-file-icon--json" aria-hidden="true" />
  return <FileText className="mock-file-icon" aria-hidden="true" />
}

function FilesPanel({ t }: { t: number }) {
  const changed = changedFiles(t)
  return (
    <aside className="mock-files">
      <div className="mock-files__tabs">
        <span>Info</span>
        <span>
          Changes {changed.size > 0 && <small key={changed.size} className="mock-count">{changed.size}</small>}
        </span>
        <span className="mock-files__tab--active">Files</span>
        <span className="mock-files__branch">
          <GitBranch aria-hidden="true" />
          main
        </span>
      </div>
      <div className="mock-files__search">
        <Search aria-hidden="true" />
        Go to file
      </div>
      <div className="mock-tree">
        {TREE.map((row) => {
          const change = row.path ? changed.get(row.path) : undefined
          if (row.path && CREATED.has(row.path) && !change) return null
          const fresh = change && t - change.at < 1_400
          const className = ['mock-tree__row', change && 'mock-tree__row--changed', fresh && 'mock-tree__row--fresh']
            .filter(Boolean)
            .join(' ')
          return (
            <div key={row.name} className={className} style={{ paddingLeft: 8 + row.depth * 14 }}>
              {row.folder ? (
                <>
                  <ChevronRight
                    className={row.folder === 'open' ? 'mock-tree__chevron mock-tree__chevron--open' : 'mock-tree__chevron'}
                    aria-hidden="true"
                  />
                  <Folder className="mock-file-icon" aria-hidden="true" />
                </>
              ) : (
                <FileIcon name={row.name} />
              )}
              <span className="mock-tree__name">{row.name}</span>
              {change && <span className={`mock-git mock-git--${change.status}`}>{change.status}</span>}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

function DesktopMock({ t }: { t: number }) {
  const titled = t >= SEND_1 + 600
  const started = t >= SEND_1
  return (
    <div className="mock-window">
      <DesktopSidebar t={t} />

      <main className="mock-main">
        <header className="mock-main__header">
          <span className="mock-main__project">{PROJECT}</span>
          {titled && <span className="mock-main__title mock-enter">{THREAD_TITLE}</span>}
          <span className="mock-main__status">
            <span className={syncPulse(t, 'desktop') ? 'mock-dot mock-dot--pulse' : 'mock-dot'} />
            Connected
            <ChevronDown aria-hidden="true" />
          </span>
          <PanelLeft aria-hidden="true" />
          <PanelRight aria-hidden="true" />
        </header>

        <Viewport className={fading(t) ? 'mock-main__transcript mock-fade' : 'mock-main__transcript'}>
          {started ? (
            <Transcript t={t} device="desktop" />
          ) : (
            <p className="mock-empty mock-enter">
              Ready to turn an idea into something real in <u>{PROJECT}</u>?
            </p>
          )}
        </Viewport>

        <Composer t={t} />
      </main>

      <FilesPanel t={t} />
    </div>
  )
}

/* Phone ------------------------------------------------------------------------- */

function PhoneMock({ t }: { t: number }) {
  const started = t >= seenAt(SEND_1, 'desktop', 'phone')
  const titled = t >= seenAt(SEND_1 + 600, 'desktop', 'phone')
  const draft = typed(PROMPT_2, PHONE_TYPE_AT, SEND_2, t)
  const sending = t >= SEND_2 - 220 && t < SEND_2 + 120
  return (
    <div className="mock-phone">
      <div className="mock-phone__screen">
        <div className="mock-phone__status">
          <span>9:41</span>
          <span className="mock-phone__island" />
          <span className="mock-phone__signal" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
          </span>
        </div>

        <div className="mock-phone__header">
          <ChevronLeft aria-hidden="true" />
          <span>
            <strong>{titled ? THREAD_TITLE : 'New chat'}</strong>
            <small>
              {PROJECT} · Claude
            </small>
          </span>
          <span className={syncPulse(t, 'phone') ? 'mock-dot mock-dot--lg mock-dot--pulse' : 'mock-dot mock-dot--lg'} />
        </div>

        <Viewport className={fading(t) ? 'mock-phone__body mock-fade' : 'mock-phone__body'}>
          {started ? (
            <Transcript t={t} device="phone" />
          ) : (
            <p className="mock-empty mock-empty--phone">New chat in {PROJECT}</p>
          )}
        </Viewport>

        <div className="mock-phone__composer">
          <span className="mock-phone__button">
            <Plus aria-hidden="true" />
          </span>
          <span className={draft ? 'mock-phone__input' : 'mock-phone__input mock-phone__input--empty'}>
            {draft || 'Message'}
            {draft && <span className="mock-caret" />}
          </span>
          <span
            className={[
              'mock-phone__button',
              draft && 'mock-phone__button--send',
              sending && 'mock-send--pressed',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {draft ? <Send aria-hidden="true" /> : <Mic aria-hidden="true" />}
          </span>
        </div>
        <span className="mock-phone__home" />
      </div>
    </div>
  )
}

function syncPulse(t: number, device: Device) {
  return SYNC_EVENTS.some((at) => {
    const local = t - at
    return local >= 0 && local < (device === 'desktop' ? 900 : 900 + SYNC_LAG)
  })
}

function fading(t: number) {
  return t >= LOOP_MS - FADE_MS
}

export function ProductShowcase() {
  const { t, ref } = useShowcaseClock()
  return (
    <section className="showcase" aria-label="FalconDeck on Mac and iPhone">
      <div className="showcase__caption">
        <p>One workspace · at your desk or on your phone</p>
        <p className="showcase__status">
          <span className={syncPulse(t, 'desktop') ? 'status-dot mock-dot--pulse' : 'status-dot'} />
          {syncPulse(t, 'phone') ? 'Synced to iPhone' : 'iPhone paired'}
        </p>
      </div>
      <div
        ref={ref}
        className="showcase__stage"
        role="img"
        aria-label="The FalconDeck Mac app running a Claude task in a project, with the same conversation mirrored live on a paired iPhone."
      >
        <div className="showcase__desktop">
          <DesktopMock t={t} />
        </div>
        <PhoneMock t={t} />
      </div>
    </section>
  )
}

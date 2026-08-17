import { useEffect, type ReactNode } from 'react'

import { Check, ChevronLeft, ChevronRight, CircleDot, Code2, Download, Github, Zap } from 'lucide-react'

const REPO_URL = 'https://github.com/jamesblackwell/falcondeck'
const RELEASES_URL = 'https://github.com/jamesblackwell/falcondeck/releases'
const APP_URL = 'https://app.falcondeck.com'
const SELF_HOSTING_URL = 'https://github.com/jamesblackwell/falcondeck/blob/main/docs/SELF-HOSTING.md'

/** The key badges in the hero are real: `d` downloads, `s` opens the source. */
function useKeyShortcuts() {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target && (target.isContentEditable || /^(input|textarea|select)$/i.test(target.tagName))) return

      const key = event.key.toLowerCase()
      if (key === 'd') window.location.href = RELEASES_URL
      else if (key === 's') window.location.href = REPO_URL
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}

function KeyBadge({ children, variant }: { children: string; variant?: 'ghost' }) {
  return <kbd className={variant === 'ghost' ? 'key-badge key-badge--ghost' : 'key-badge'}>{children}</kbd>
}

function Feature({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="feature">
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  )
}

function Thread({ title, meta, active }: { title: string; meta: string; active?: boolean }) {
  return (
    <div className={active ? 'mock-thread mock-thread--active' : 'mock-thread'}>
      <CircleDot aria-hidden="true" />
      <span>
        <strong>{title}</strong>
        <small>{meta}</small>
      </span>
    </div>
  )
}

function ToolRow({ label, file, state }: { label: string; file: string; state: 'done' | 'running' }) {
  return (
    <div className={state === 'running' ? 'mock-tool mock-tool--running' : 'mock-tool'}>
      {state === 'running' ? <Zap aria-hidden="true" /> : <Check aria-hidden="true" />}
      <span>
        {label} <code>{file}</code>
      </span>
      <small>{state}</small>
    </div>
  )
}

function DesktopMock() {
  return (
    <div className="mock-window">
      <div className="mock-window__bar">
        <div className="mock-window__dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="mock-window__title">
          <img src="/logomark-mark-light.svg" alt="" />
          falcondeck / control plane
        </div>
        <div />
      </div>

      <div className="mock-window__body">
        <aside className="mock-sidebar">
          <div className="mock-sidebar__workspace">
            <span className="mock-avatar">F</span>
            <span>
              <strong>FalconDeck</strong>
              <small>local workspace</small>
            </span>
            <ChevronRight aria-hidden="true" />
          </div>

          <p className="mock-label">Workspaces</p>
          <div className="mock-project">
            <span className="mock-project__mark">⌘</span>
            <span>falcondeck</span>
            <span className="mock-project__count">2</span>
          </div>

          <p className="mock-label mock-label--spaced">Threads</p>
          <Thread title="Add user authentication" meta="Claude · just now" active />
          <Thread title="Fix database migration" meta="Codex · 45 min ago" />
          <Thread title="Rename relay events" meta="OpenCode · 2 h ago" />

          <div className="mock-sidebar__footer">
            <span className="status-dot" />
            <span>2 agents connected</span>
          </div>
        </aside>

        <main className="mock-conversation">
          <div className="mock-conversation__header">
            <div>
              <p className="mock-label">Thread · Claude Sonnet 4.6</p>
              <h3>Add user authentication</h3>
            </div>
            <span className="mock-pill">LIVE</span>
          </div>

          <div className="mock-message mock-message--user">
            Add JWT authentication to the Express API. Use bcrypt for password hashing.
          </div>
          <div className="mock-message mock-message--agent">
            I&apos;ll map the existing routes first, then add the auth middleware and run the test suite.
          </div>

          <div className="mock-tools">
            <ToolRow label="Read" file="src/server.ts" state="done" />
            <ToolRow label="Edit" file="src/middleware/auth.ts" state="done" />
            <ToolRow label="Run" file="npm test" state="running" />
          </div>

          <div className="mock-composer">
            <span>Ask Claude to continue…</span>
            <span className="mock-composer__send">↑</span>
          </div>
        </main>

        <aside className="mock-inspector">
          <p className="mock-label">Session</p>
          <div className="mock-inspector__state">
            <span className="status-dot" />
            <span>
              <strong>Desktop online</strong>
              <small>encrypted connection</small>
            </span>
          </div>

          <div className="mock-inspector__row">
            <span>Provider</span>
            <strong>Claude</strong>
          </div>
          <div className="mock-inspector__row">
            <span>Permission mode</span>
            <strong>On request</strong>
          </div>

          <div className="mock-inspector__divider" />

          <p className="mock-label">Workspace</p>
          <div className="mock-inspector__path">
            <Code2 aria-hidden="true" />
            <code>~/Sites/falcondeck</code>
          </div>

          <div className="mock-diff">
            <span>
              <i className="mock-diff__bar mock-diff__bar--add" />
              <strong>+42</strong>
            </span>
            <span>
              <i className="mock-diff__bar mock-diff__bar--del" />
              <strong>-8</strong>
            </span>
          </div>
          <small className="mock-diff__caption">working tree</small>
        </aside>
      </div>
    </div>
  )
}

function PhoneMock() {
  return (
    <div className="mock-phone">
      <div className="mock-phone__screen">
        <div className="mock-phone__status">
          <span>9:41</span>
          <span className="mock-phone__paired">
            <span className="status-dot" />
            paired
          </span>
        </div>

        <div className="mock-phone__header">
          <ChevronLeft aria-hidden="true" />
          <span>
            <strong>Add user authentication</strong>
            <small>falcondeck · Claude</small>
          </span>
          <span className="mock-pill mock-pill--sm">LIVE</span>
        </div>

        <div className="mock-phone__body">
          <div className="mock-message mock-message--user">Add JWT authentication to the Express API.</div>
          <div className="mock-message mock-message--agent">
            I&apos;ll map the existing routes first, then add the auth middleware and run the test suite.
          </div>
          <div className="mock-tools">
            <div className="mock-tool">
              <Check aria-hidden="true" />
              <span>
                Edit <code>auth.ts</code>
              </span>
            </div>
            <div className="mock-tool mock-tool--running">
              <Zap aria-hidden="true" />
              <span>
                Run <code>npm test</code>
              </span>
              <small>running</small>
            </div>
          </div>
        </div>

        <div className="mock-phone__composer">
          <span>Reply from your phone…</span>
          <span className="mock-composer__send">↑</span>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  useKeyShortcuts()

  return (
    <div className="site-frame">
      <div className="site-rail site-rail--left" aria-hidden="true" />
      <div className="site-rail site-rail--right" aria-hidden="true" />

      <header className="site-header">
        <a className="brand-lockup" href="#top" aria-label="FalconDeck home">
          <img src="/logomark-mark-light.svg" alt="" />
          <span>FalconDeck</span>
        </a>
        <nav className="site-nav" aria-label="Main navigation">
          <a href="#product">Product</a>
          <a href="#security">Security</a>
          <a href="#architecture">Architecture</a>
          <a href={REPO_URL}>Docs</a>
        </nav>
        <div className="site-header__actions">
          <a className="nav-link" href={APP_URL}>
            Remote client
          </a>
          <a className="btn btn--accent btn--sm" href={RELEASES_URL}>
            Download
            <KeyBadge>D</KeyBadge>
          </a>
        </div>
      </header>

      <main>
        <section className="hero" id="top">
          <p className="eyebrow">
            <span className="status-dot" />
            Open source · any coding agent
          </p>
          <h1>
            <span>Start on your Mac.</span> <span>Keep going from your phone.</span>
          </h1>
          <p className="hero__lede">
            FalconDeck runs Codex, Claude Code, OpenCode, and any ACP harness against your own code — then hands you the
            same live session on your phone or browser. One daemon owns the turn, so there is nothing to catch up.
          </p>
          <div className="hero__actions">
            <a className="btn btn--accent" href={RELEASES_URL}>
              <Download aria-hidden="true" />
              Download for Mac
              <KeyBadge>D</KeyBadge>
            </a>
            <a className="btn btn--outline" href={REPO_URL}>
              <Github aria-hidden="true" />
              Read the source
              <KeyBadge variant="ghost">S</KeyBadge>
            </a>
          </div>
          <p className="hero__footnote">macOS · end-to-end encrypted · MIT licensed</p>
        </section>

        <section className="features" id="product">
          <Feature title="Any harness">
            Run Codex, Claude Code, OpenCode, and other ACP agents with the subscriptions and model access you already
            have.
          </Feature>
          <Feature title="Local-first">
            Your daemon and native agent storage stay the source of truth. The relay only pairs, replays, and
            reconnects.
          </Feature>
          <Feature title="In sync">
            One daemon owns the live turn, so desktop, browser, and phone follow the same thread with nothing to catch
            up.
          </Feature>
        </section>

        <section className="showcase">
          <div className="showcase__caption">
            <p>FalconDeck desktop · live Claude session</p>
            <p className="showcase__status">
              <span className="status-dot" />
              Daemon online
            </p>
          </div>
          <div className="showcase__stage">
            <div className="showcase__desktop">
              <DesktopMock />
            </div>
            <PhoneMock />
          </div>
        </section>

        <section className="harnesses" id="architecture">
          <p className="harnesses__label">Works with</p>
          <div className="harnesses__list">
            <span>Codex</span>
            <span>Claude Code</span>
            <span>OpenCode</span>
            <span>Pi</span>
            <span className="harnesses__more">+ any ACP harness</span>
          </div>
        </section>

        <section className="security" id="security">
          <div className="security__points">
            <span>
              <Check aria-hidden="true" />
              End-to-end encrypted
            </span>
            <span>
              <Check aria-hidden="true" />
              No hosted conversation database
            </span>
            <span>
              <Check aria-hidden="true" />
              Self-hostable relay
            </span>
          </div>
          <a className="text-link" href={SELF_HOSTING_URL}>
            Self-hosting guide
            <ChevronRight aria-hidden="true" />
          </a>
        </section>
      </main>

      <footer className="site-footer">
        <div className="site-footer__brand">
          <img src="/logomark-mark-light.svg" alt="" />
          <span>FalconDeck</span>
          <small>Open-source control plane for the agents you already use.</small>
        </div>
        <div className="site-footer__links">
          <a href={REPO_URL}>GitHub</a>
          <a href={RELEASES_URL}>Releases</a>
          <a href={APP_URL}>Remote client</a>
        </div>
      </footer>
    </div>
  )
}

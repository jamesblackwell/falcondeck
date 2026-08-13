import type { ReactNode } from 'react'

import {
  ArrowRight,
  Boxes,
  Check,
  ChevronRight,
  CircleDot,
  Code2,
  Download,
  Gauge,
  Github,
  LockKeyhole,
  Puzzle,
  Server,
  Smartphone,
  Zap,
} from 'lucide-react'
import { Button } from '@falcondeck/ui'

const REPO_URL = 'https://github.com/jamesblackwell/falcondeck'
const RELEASES_URL = 'https://github.com/jamesblackwell/falcondeck/releases'
const APP_URL = 'https://app.falcondeck.com'

function ProductPreview() {
  return (
    <div className="product-preview" aria-label="FalconDeck product preview">
      <div className="product-preview__glow" aria-hidden="true" />
      <div className="window-frame">
        <div className="window-frame__bar">
          <div className="window-frame__dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="window-frame__title">
            <img src="/icon-192.png" alt="" />
            falcondeck / control plane
          </div>
          <div className="window-frame__status">
            <span className="status-dot" />
            daemon online
          </div>
        </div>

        <div className="product-preview__body">
          <aside className="preview-sidebar">
            <div className="preview-sidebar__workspace">
              <span className="preview-avatar">F</span>
              <span>
                <strong>FalconDeck</strong>
                <small>local workspace</small>
              </span>
              <ChevronRight className="preview-chevron" aria-hidden="true" />
            </div>
            <p className="preview-label">WORKSPACES</p>
            <div className="preview-project preview-project--active">
              <span className="preview-project__mark">⌘</span>
              <span>falcondeck</span>
              <span className="preview-project__count">2</span>
            </div>
            <p className="preview-label preview-label--threads">THREADS</p>
            <div className="preview-thread preview-thread--active">
              <CircleDot aria-hidden="true" />
              <span>
                <strong>Add user authentication</strong>
                <small>Claude · just now</small>
              </span>
            </div>
            <div className="preview-thread">
              <CircleDot aria-hidden="true" />
              <span>
                <strong>Fix database migration</strong>
                <small>Codex · 45 min ago</small>
              </span>
            </div>
            <div className="preview-sidebar__footer">
              <span className="preview-footer-dot" />
              <span>2 agents connected</span>
            </div>
          </aside>

          <main className="preview-conversation">
            <div className="preview-conversation__header">
              <div>
                <p className="preview-kicker">THREAD · CLAUDE OPUS</p>
                <h3>Add user authentication</h3>
              </div>
              <span className="preview-pill">LIVE</span>
            </div>
            <div className="preview-message preview-message--user">
              Add JWT authentication to the Express API. Use bcrypt for password hashing.
            </div>
            <div className="preview-message preview-message--assistant">
              I&apos;ll map the existing routes first, then add the auth middleware and run the test suite.
            </div>
            <div className="preview-tool-list">
              <div className="preview-tool preview-tool--done">
                <Check aria-hidden="true" />
                <span>Read <code>src/server.ts</code></span>
                <small>done</small>
              </div>
              <div className="preview-tool preview-tool--done">
                <Check aria-hidden="true" />
                <span>Edit <code>src/middleware/auth.ts</code></span>
                <small>done</small>
              </div>
              <div className="preview-tool preview-tool--active">
                <Zap aria-hidden="true" />
                <span>Run <code>npm test</code></span>
                <small>running</small>
              </div>
            </div>
            <div className="preview-composer">
              <span>Ask Claude to continue…</span>
              <span className="preview-composer__send">↑</span>
            </div>
          </main>

          <aside className="preview-inspector">
            <p className="preview-label">SESSION</p>
            <div className="preview-inspector__state">
              <span className="status-dot" />
              <span>
                <strong>Desktop online</strong>
                <small>encrypted connection</small>
              </span>
            </div>
            <div className="preview-inspector__row">
              <span>Provider</span>
              <strong>Claude</strong>
            </div>
            <div className="preview-inspector__row">
              <span>Permission mode</span>
              <strong>On request</strong>
            </div>
            <div className="preview-inspector__divider" />
            <p className="preview-label">WORKSPACE</p>
            <div className="preview-inspector__path">
              <Code2 aria-hidden="true" />
              <code>~/Sites/falcondeck</code>
            </div>
            <div className="preview-diff">
              <div>
                <span className="preview-diff__bar preview-diff__bar--green" />
                <strong>+42</strong>
              </div>
              <div>
                <span className="preview-diff__bar preview-diff__bar--red" />
                <strong>-8</strong>
              </div>
              <small>working tree</small>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

function Card({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <article className="surface-card">
      <div className="surface-card__icon" aria-hidden="true">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
    </article>
  )
}

export default function App() {
  return (
    <div className="site-shell">
      <div className="site-grid" aria-hidden="true" />

      <header className="site-header">
        <nav className="site-nav" aria-label="Main navigation">
          <a className="brand-lockup" href="#top" aria-label="FalconDeck home">
            <img src="/icon-192.png" alt="" />
            <span>FalconDeck</span>
          </a>
          <div className="site-nav__actions">
            <a className="nav-link" href={RELEASES_URL}>
              <Download className="icon-xs" aria-hidden="true" />
              Download
            </a>
            <a className="nav-link" href={APP_URL}>
              Remote client
            </a>
            <Button size="sm" asChild>
              <a href={REPO_URL}>
                <Github className="icon-xs" aria-hidden="true" />
                GitHub
              </a>
            </Button>
          </div>
        </nav>
      </header>

      <main id="top">
        <section className="hero section-wrap">
          <div className="hero__copy">
            <p className="eyebrow">OPEN SOURCE · LOCAL-FIRST</p>
            <h1>Code with <span>any agent, on every screen.</span></h1>
            <p className="hero__lede">
              Keep the harnesses and model subscriptions you already use close to your code. Continue the same live
              work from your desktop, browser, or phone — with no second copy of the conversation to catch up.
            </p>
            <div className="hero__actions">
              <Button size="lg" asChild>
                <a href={REPO_URL}>
                  <Github className="icon-sm" aria-hidden="true" />
                  Read the source
                  <ArrowRight className="icon-sm" aria-hidden="true" />
                </a>
              </Button>
              <Button variant="outline" size="lg" asChild>
                <a href={RELEASES_URL}>
                  <Download className="icon-sm" aria-hidden="true" />
                  Download for Mac
                </a>
              </Button>
            </div>
            <div className="hero__proof">
              <span><Check className="icon-xs" aria-hidden="true" /> MIT licensed</span>
              <span><Check className="icon-xs" aria-hidden="true" /> End-to-end encrypted</span>
              <span><Check className="icon-xs" aria-hidden="true" /> Rust based</span>
            </div>
          </div>
          <ProductPreview />
        </section>

        <section className="section-wrap section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">THE IMPORTANT PARTS</p>
              <h2>Everything you need to keep coding moving.</h2>
            </div>
            <p>
              FalconDeck is a fast, open control plane for coding agents. It keeps your files and agent sessions where
              they belong, then makes the work available wherever you are.
            </p>
          </div>
          <div className="surface-grid">
            <Card
              icon={<Server aria-hidden="true" />}
              title="Open source, self-hostable"
              description="The daemon, relay, clients, and protocol are open source and fully self-hostable. Run the whole stack on infrastructure you control."
            />
            <Card
              icon={<LockKeyhole aria-hidden="true" />}
              title="Use the relay with confidence"
              description="Pair your phone or browser in minutes using our hosted relay. The connection is end-to-end encrypted, so you can test the fast path before self-hosting."
            />
            <Card
              icon={<Boxes aria-hidden="true" />}
              title="Bring any harness"
              description="Use Codex, Claude, OpenCode, Pi, and other ACP-compatible harnesses with the subscriptions and model access you already have."
            />
            <Card
              icon={<Smartphone aria-hidden="true" />}
              title="Desktop and mobile, in sync"
              description="One daemon owns the live work, so your desktop, browser, and phone follow the same thread without laggy sync or competing copies."
            />
            <Card
              icon={<Gauge aria-hidden="true" />}
              title="Fast by design"
              description="A native Rust app and server keep streaming output, approvals, and tool calls responsive while the agent works."
            />
            <Card
              icon={<Puzzle aria-hidden="true" />}
              title="Extensible from the start"
              description="Add extensions, actions, and connectors to fit your workflow. New harnesses can arrive through configuration instead of a rewrite."
            />
          </div>
        </section>

        <section className="section-wrap section-block">
          <div className="relay-card">
            <div>
              <p className="eyebrow">TRY IT FIRST</p>
              <h2>Use our relay today. Self-host when you need to.</h2>
              <p>
                You should not have to run your own infrastructure just to see whether remote coding fits your day.
                Start with the hosted relay, pair your phone, and move to your own relay whenever you want.
              </p>
            </div>
            <div className="relay-card__points" aria-label="Relay benefits">
              <span><Check className="icon-xs" aria-hidden="true" /> End-to-end encrypted</span>
              <span><Check className="icon-xs" aria-hidden="true" /> No hosted conversation database</span>
              <span><Check className="icon-xs" aria-hidden="true" /> Self-hostable whenever you are ready</span>
            </div>
          </div>
        </section>

        <section className="section-wrap cta-section">
          <div className="cta-card">
            <div>
              <p className="eyebrow">OPEN SOURCE · EXTENSIBLE</p>
              <h2>Start with the agents you already use.</h2>
              <p>
                Download the desktop app, pair your phone, or inspect the code and run the stack yourself. FalconDeck
                is built to fit around your workflow, not replace it.
              </p>
            </div>
            <div className="cta-card__actions">
              <Button size="lg" asChild>
                <a href={REPO_URL}>
                  <Github className="icon-sm" aria-hidden="true" />
                  Read the source
                  <ArrowRight className="icon-sm" aria-hidden="true" />
                </a>
              </Button>
              <a className="text-link" href={RELEASES_URL}>
                Download desktop builds <ChevronRight className="icon-xs" aria-hidden="true" />
              </a>
              <a className="text-link" href={APP_URL}>
                Open the remote client <ChevronRight className="icon-xs" aria-hidden="true" />
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="site-footer__inner">
          <div className="brand-lockup brand-lockup--footer">
            <img src="/icon-192.png" alt="" />
            <span>FalconDeck</span>
          </div>
          <p>Open source control for the agents you already use.</p>
          <div className="site-footer__links">
            <a href={REPO_URL}>GitHub</a>
            <a href={RELEASES_URL}>Releases</a>
            <a href={APP_URL}>Remote client</a>
          </div>
        </div>
      </footer>
    </div>
  )
}

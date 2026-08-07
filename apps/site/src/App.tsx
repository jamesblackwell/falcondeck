import type { ReactNode } from 'react'

import {
  ArrowRight,
  Check,
  ChevronRight,
  CircleDot,
  Cloud,
  Code2,
  Download,
  Github,
  LockKeyhole,
  Monitor,
  Radio,
  ShieldCheck,
  Smartphone,
  Terminal,
  Zap,
} from 'lucide-react'
import { Button } from '@falcondeck/ui'

type FeatureCardProps = {
  icon: ReactNode
  eyebrow: string
  title: string
  description: string
}

function FeatureCard({ icon, eyebrow, title, description }: FeatureCardProps) {
  return (
    <article className="feature-card">
      <div className="feature-card__icon" aria-hidden="true">
        {icon}
      </div>
      <p className="eyebrow eyebrow--small">{eyebrow}</p>
      <h3>{title}</h3>
      <p className="feature-card__description">{description}</p>
    </article>
  )
}

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
                <p className="preview-kicker">THREAD · CLAUDE SONNET 4.6</p>
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

function SurfaceCard({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <div className="surface-card">
      <div className="surface-card__icon" aria-hidden="true">{icon}</div>
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      <ArrowRight className="surface-card__arrow" aria-hidden="true" />
    </div>
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
          <div className="site-nav__links">
            <a href="#product">Product</a>
            <a href="#security">Security</a>
            <a href="#architecture">Architecture</a>
          </div>
          <div className="site-nav__actions">
            <a className="nav-download" href="https://github.com/jamesblackwell/falcondeck/releases">
              <Download className="icon-xs" aria-hidden="true" />
              Downloads
            </a>
            <a className="nav-github" href="https://github.com/jamesblackwell/falcondeck">
              <Github className="icon-xs" aria-hidden="true" />
              GitHub
            </a>
            <Button size="sm" asChild>
              <a href="https://app.falcondeck.com">
                Open app
                <ArrowRight className="icon-xs" aria-hidden="true" />
              </a>
            </Button>
          </div>
        </nav>
      </header>

      <main id="top">
        <section className="hero section-wrap">
          <div className="hero__copy">
            <div className="eyebrow">
              <span className="eyebrow__dot" />
              AI-FIRST WORK · LOCAL-FIRST CORE
            </div>
            <h1>One control plane for <span>AI-first work.</span></h1>
            <p className="hero__lede">
              FalconDeck starts with coding agents. Run Codex and Claude close to your code, follow their work from your Mac, browser, or iPhone, and keep people in the loop as more of the company runs in the background.
            </p>
            <div className="hero__actions">
              <Button size="lg" asChild>
                <a href="https://github.com/jamesblackwell/falcondeck">
                  <Github className="icon-sm" aria-hidden="true" />
                  Explore the source
                  <ArrowRight className="icon-sm" aria-hidden="true" />
                </a>
              </Button>
              <Button variant="outline" size="lg" asChild>
                <a href="https://app.falcondeck.com">
                  Open remote client
                  <ChevronRight className="icon-sm" aria-hidden="true" />
                </a>
              </Button>
            </div>
            <div className="hero__proof">
              <span><Check className="icon-xs" aria-hidden="true" /> Open source</span>
              <span><Check className="icon-xs" aria-hidden="true" /> End-to-end encrypted</span>
              <span><Check className="icon-xs" aria-hidden="true" /> Self-hostable relay</span>
            </div>
            <a className="release-link" href="https://github.com/jamesblackwell/falcondeck/releases">
              <Download className="icon-xs" aria-hidden="true" />
              Download desktop builds from Releases
              <ChevronRight className="icon-xs" aria-hidden="true" />
            </a>
          </div>
          <ProductPreview />
        </section>

        <section className="signal-strip section-wrap" aria-label="FalconDeck product summary">
          <div className="signal-strip__item">
            <span className="signal-strip__icon"><Terminal aria-hidden="true" /></span>
            <span><strong>One control plane</strong><small>for Codex + Claude</small></span>
          </div>
          <div className="signal-strip__item">
            <span className="signal-strip__icon"><LockKeyhole aria-hidden="true" /></span>
            <span><strong>Your daemon is the source of truth</strong><small>not a hosted conversation database</small></span>
          </div>
          <div className="signal-strip__item">
            <span className="signal-strip__icon"><Radio aria-hidden="true" /></span>
            <span><strong>Remote when you need it</strong><small>desktop, web, and mobile surfaces</small></span>
          </div>
        </section>

        <section className="section-wrap screenshot-section">
          <div className="screenshot-heading">
            <div>
              <p className="eyebrow">THE REAL INTERFACE</p>
              <h2>See the surface your agents work inside.</h2>
            </div>
            <p>
              Live conversations, tool activity, model controls, and the next prompt all stay in one focused desktop view.
            </p>
          </div>
          <figure className="real-product-shot">
            <div className="real-product-shot__bar" aria-hidden="true">
              <span />
              <span />
              <span />
              <small>FalconDeck desktop · live Claude session</small>
            </div>
            <img
              src="/falcondeck-preview.png"
              alt="FalconDeck desktop app showing a live Claude thread with code, agent controls, and a prompt composer"
            />
            <figcaption>Built around the work itself: a live thread, visible agent activity, and a prompt ready for the next move.</figcaption>
          </figure>
        </section>

        <section id="product" className="section-wrap section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">THE PRODUCT</p>
              <h2>Start with coding agents. Build toward a wider system.</h2>
            </div>
            <p>
              The first use case is coding because it is where teams already run agents every day. The architecture is designed for a wider future, with agents from different harnesses and environments brought into one place.
            </p>
          </div>
          <div className="surface-grid">
            <SurfaceCard
              icon={<Monitor aria-hidden="true" />}
              title="Desktop command center"
              description="A native shell around the local daemon, with rich conversation rendering and a workspace-aware view of your agents."
            />
            <SurfaceCard
              icon={<Smartphone aria-hidden="true" />}
              title="Remote handoff"
              description="Pair a phone or browser, follow a live turn, send the next prompt, and keep moving when you leave your desk."
            />
            <SurfaceCard
              icon={<ShieldCheck aria-hidden="true" />}
              title="Approvals with context"
              description="Review permission requests and code changes where they happen, then approve or deny without losing the thread."
            />
          </div>
        </section>

        <section id="security" className="section-wrap section-block security-section">
          <div className="security-panel">
            <div className="security-panel__copy">
              <p className="eyebrow">LOCAL BY DEFAULT</p>
              <h2>Remote access without moving the center of gravity.</h2>
              <p>
                The FalconDeck daemon and the native agent storage remain the source of truth. The relay helps devices pair, reconnect, and catch up. It does not become a second conversation database.
              </p>
              <div className="security-checks">
                <span><Check aria-hidden="true" /> End-to-end encrypted remote payloads</span>
                <span><Check aria-hidden="true" /> Self-hostable relay for your infrastructure</span>
                <span><Check aria-hidden="true" /> Same-folder workflows by default</span>
              </div>
            </div>
            <div className="security-panel__diagram" aria-label="Local daemon to encrypted relay to remote clients">
              <div className="diagram-node diagram-node--primary">
                <Terminal aria-hidden="true" />
                <strong>Local daemon</strong>
                <small>source of truth</small>
              </div>
              <div className="diagram-line"><span>encrypted events</span></div>
              <div className="diagram-node">
                <Radio aria-hidden="true" />
                <strong>Relay</strong>
                <small>pair · replay · reconnect</small>
              </div>
              <div className="diagram-branches">
                <span />
                <span />
              </div>
              <div className="diagram-clients">
                <div><Monitor aria-hidden="true" /><span>desktop</span></div>
                <div><Smartphone aria-hidden="true" /><span>mobile</span></div>
                <div><Cloud aria-hidden="true" /><span>browser</span></div>
              </div>
            </div>
          </div>
        </section>

        <section id="architecture" className="section-wrap section-block architecture-section">
          <div className="section-heading section-heading--centered">
            <p className="eyebrow">BUILT TO STAY OUT OF YOUR WAY</p>
            <h2>One daemon. Every surface.</h2>
            <p>
              A shared Rust protocol and client core keep desktop, web, and mobile aligned as the system evolves.
            </p>
          </div>
          <div className="feature-grid">
            <FeatureCard
              icon={<Zap aria-hidden="true" />}
              eyebrow="01 / FLOW"
              title="Live sessions, not snapshots"
              description="Stream turns, tool activity, approvals, and status changes as they happen, with reconnect support built into the protocol."
            />
            <FeatureCard
              icon={<LockKeyhole aria-hidden="true" />}
              eyebrow="02 / TRUST"
              title="Your infrastructure, your choice"
              description="Use the hosted relay or deploy the server-side pieces yourself with the included Ansible path and PostgreSQL support."
            />
            <FeatureCard
              icon={<Code2 aria-hidden="true" />}
              eyebrow="03 / CRAFT"
              title="Open source end to end"
              description="The daemon, relay, clients, shared protocol, and public site live together in one MIT-licensed monorepo."
            />
          </div>
        </section>

        <section className="section-wrap cta-section">
          <div className="cta-card">
            <div>
              <p className="eyebrow">OPEN SOURCE, ON PURPOSE</p>
              <h2>It will take a community to build this.</h2>
              <p>FalconDeck is an ambitious project. We are starting with coding agents, but the destination is a control plane for AI-first companies. Contributors will help shape the daemon, clients, integrations, and experience along the way.</p>
            </div>
            <div className="cta-card__actions">
              <Button size="lg" asChild>
                <a href="https://github.com/jamesblackwell/falcondeck">
                  Join the project
                  <ArrowRight className="icon-sm" aria-hidden="true" />
                </a>
              </Button>
              <a className="text-link" href="https://app.falcondeck.com">
                Open the remote client <ChevronRight className="icon-xs" aria-hidden="true" />
              </a>
              <a className="text-link" href="https://github.com/jamesblackwell/falcondeck/releases">
                Download desktop builds <Download className="icon-xs" aria-hidden="true" />
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
          <p>Open-source infrastructure for people who build with agents.</p>
          <div className="site-footer__links">
            <a href="https://github.com/jamesblackwell/falcondeck">GitHub</a>
            <a href="https://app.falcondeck.com">Remote client</a>
            <a href="https://github.com/jamesblackwell/falcondeck/releases">Releases</a>
          </div>
        </div>
      </footer>
    </div>
  )
}

import type { ReactNode } from 'react'

import {
  ArrowRight,
  Check,
  ChevronRight,
  CircleDot,
  Code2,
  Download,
  Github,
  Monitor,
  ShieldCheck,
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

/**
 * Hand-drawn schematic of the data path: agents run in the local daemon, the
 * relay only brokers encrypted traffic, every client is just another viewer.
 */
function FlowIllustration() {
  return (
    <div className="flow-illustration">
      <svg
        viewBox="0 0 1120 372"
        role="img"
        aria-label="Agents run in a daemon on your machine. An encrypted relay connects that daemon to the desktop app, the browser client, and your phone."
        className="flow-svg"
      >
        <defs>
          <radialGradient id="fd-node-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--fd-accent)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--fd-accent)" stopOpacity="0" />
          </radialGradient>
        </defs>

        {/* ---------- your machine ---------- */}
        <rect
          x="16"
          y="44"
          width="392"
          height="300"
          rx="22"
          fill="var(--fd-bg-1)"
          stroke="var(--fd-border-1)"
          strokeDasharray="5 7"
        />
        <text x="36" y="30" className="flow-tag">YOUR MACHINE</text>

        <rect x="48" y="76" width="328" height="88" rx="14" fill="var(--fd-bg-2)" stroke="var(--fd-accent-muted)" />
        <circle cx="78" cy="112" r="14" fill="url(#fd-node-glow)" />
        <circle cx="78" cy="112" r="4.5" fill="var(--fd-accent)" />
        <text x="102" y="111" className="flow-title">falcondeck daemon</text>
        <text x="102" y="133" className="flow-sub">holds every thread, transcript, and approval</text>

        <rect x="48" y="184" width="158" height="72" rx="12" fill="var(--fd-bg-2)" stroke="var(--fd-border-1)" />
        <text x="68" y="215" className="flow-node">Claude</text>
        <text x="68" y="235" className="flow-sub">running</text>
        <circle cx="184" cy="210" r="4" fill="var(--fd-accent)" className="flow-pulse" />

        <rect x="218" y="184" width="158" height="72" rx="12" fill="var(--fd-bg-2)" stroke="var(--fd-border-1)" />
        <text x="238" y="215" className="flow-node">Codex</text>
        <text x="238" y="235" className="flow-sub">idle</text>
        <circle cx="354" cy="210" r="4" fill="var(--fd-fg-4)" />

        <rect x="48" y="274" width="328" height="46" rx="12" fill="none" stroke="var(--fd-border-0)" />
        <path
          d="M70 307v-17h7l2.5 3.5H91v13.5a2 2 0 0 1-2 2H72a2 2 0 0 1-2-2z"
          stroke="var(--fd-fg-4)"
          fill="none"
          strokeLinejoin="round"
        />
        <text x="105" y="302" className="flow-code">~/code/api</text>
        <text x="356" y="302" textAnchor="end" className="flow-code">
          <tspan fill="var(--fd-accent)">+42</tspan> <tspan>−8</tspan>
        </text>

        {/* ---------- daemon → relay ---------- */}
        <path d="M408 194h84" stroke="var(--fd-border-2)" strokeDasharray="4 6" className="flow-wire" fill="none" />
        <text x="450" y="178" textAnchor="middle" className="flow-wire-label">encrypted</text>

        {/* ---------- relay ---------- */}
        <rect x="492" y="150" width="128" height="88" rx="18" fill="var(--fd-bg-2)" stroke="var(--fd-border-1)" />
        <path
          d="M545 192v-10a11 11 0 0 1 22 0v10"
          stroke="var(--fd-accent)"
          strokeWidth="2"
          fill="none"
          strokeLinecap="round"
        />
        <rect x="541" y="192" width="30" height="22" rx="5" fill="var(--fd-accent-muted)" stroke="var(--fd-accent)" />
        <text x="556" y="266" textAnchor="middle" className="flow-node">relay</text>
        <text x="556" y="288" textAnchor="middle" className="flow-sub">pair · reconnect · replay</text>

        {/* ---------- relay → clients ---------- */}
        <path
          d="M620 194h34M654 194V78a14 14 0 0 1 14-14h32M654 194h46M654 194v116a14 14 0 0 0 14 14h32"
          stroke="var(--fd-border-2)"
          strokeDasharray="4 6"
          className="flow-wire"
          fill="none"
        />

        {/* ---------- clients ---------- */}
        <g>
          <rect x="700" y="34" width="404" height="60" rx="14" fill="var(--fd-bg-1)" stroke="var(--fd-border-1)" />
          <rect x="724" y="52" width="28" height="20" rx="3" stroke="var(--fd-fg-2)" fill="none" />
          <path d="M732 78h12" stroke="var(--fd-fg-2)" strokeLinecap="round" />
          <text x="770" y="62" className="flow-node">Desktop</text>
          <text x="770" y="80" className="flow-sub">native Mac app around the daemon</text>
        </g>
        <g>
          <rect x="700" y="164" width="404" height="60" rx="14" fill="var(--fd-bg-1)" stroke="var(--fd-border-1)" />
          <rect x="724" y="180" width="28" height="24" rx="4" stroke="var(--fd-fg-2)" fill="none" />
          <path d="M724 188h28" stroke="var(--fd-fg-2)" />
          <text x="770" y="192" className="flow-node">Browser</text>
          <text x="770" y="210" className="flow-sub">app.falcondeck.com, paired to your Mac</text>
        </g>
        <g>
          <rect x="700" y="294" width="404" height="60" rx="14" fill="var(--fd-bg-1)" stroke="var(--fd-border-1)" />
          <rect x="729" y="308" width="18" height="30" rx="4" stroke="var(--fd-fg-2)" fill="none" />
          <path d="M735 313h6" stroke="var(--fd-fg-2)" strokeLinecap="round" />
          <text x="770" y="322" className="flow-node">iPhone</text>
          <text x="770" y="340" className="flow-sub">follow a run, answer a prompt, move on</text>
        </g>
      </svg>
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
            <div className="eyebrow">
              <span className="eyebrow__dot" />
              OPEN SOURCE · LOCAL-FIRST
            </div>
            <h1>Your coding agents, <span>on every screen.</span></h1>
            <p className="hero__lede">
              FalconDeck runs Claude and Codex on your own machine, next to your code. Watch a run, approve a
              change, or send the next prompt from your Mac, a browser tab, or your phone.
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
              <span><Check className="icon-xs" aria-hidden="true" /> Self-hostable relay</span>
            </div>
          </div>
          <ProductPreview />
        </section>

        <section className="section-wrap section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">HOW IT WORKS</p>
              <h2>Your machine stays the source of truth.</h2>
            </div>
            <p>
              Agents run in a daemon on your hardware, against your files and your credentials. The relay only
              brokers encrypted traffic so your other devices can pair and catch up — it never becomes a second
              copy of your conversations.
            </p>
          </div>
          <FlowIllustration />
        </section>

        <section className="section-wrap section-block">
          <div className="section-heading">
            <div>
              <p className="eyebrow">THE APP</p>
              <h2>Built around the work, not the chat.</h2>
            </div>
            <p>
              Coding agents come first because that is what people already run every day. The protocol underneath
              is built for whatever else you end up handing to an agent.
            </p>
          </div>
          <div className="surface-grid">
            <Card
              icon={<Monitor aria-hidden="true" />}
              title="One window, every thread"
              description="Live output, tool calls, diffs, and status for each agent you have running — grouped by the workspace it belongs to."
            />
            <Card
              icon={<Smartphone aria-hidden="true" />}
              title="Pick it up anywhere"
              description="Pair a phone or a browser tab and step into a run already in progress. Nothing is replayed from a server you don't control."
            />
            <Card
              icon={<ShieldCheck aria-hidden="true" />}
              title="Approvals with context"
              description="Permission requests arrive with the command and the change attached, so you can answer without losing your place."
            />
          </div>
        </section>

        <section className="section-wrap cta-section">
          <div className="cta-card">
            <div>
              <p className="eyebrow">EARLY, AND IN THE OPEN</p>
              <h2>Best read as code.</h2>
              <p>
                The daemon, relay, clients, and shared protocol all live in one MIT-licensed monorepo. That is
                where the roadmap, the rough edges, and the fastest answers are.
              </p>
            </div>
            <div className="cta-card__actions">
              <Button size="lg" asChild>
                <a href={REPO_URL}>
                  <Github className="icon-sm" aria-hidden="true" />
                  Open the repo
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
          <p>Open source, for people who build with agents.</p>
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

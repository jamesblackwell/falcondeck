import { useEffect, type ReactNode } from 'react'

import { Check, ChevronLeft, ChevronRight, CircleDot, Code2, Download, Github, Zap } from 'lucide-react'

const REPO_URL = 'https://github.com/jamesblackwell/falcondeck'
const RELEASES_URL = 'https://github.com/jamesblackwell/falcondeck/releases'
const APP_URL = 'https://app.falcondeck.com'
const SELF_HOSTING_URL = 'https://github.com/jamesblackwell/falcondeck/blob/main/docs/SELF-HOSTING.md'
const PRIVACY_URL = '/privacy'
const TERMS_URL = '/terms'

function SiteHeader() {
  return (
    <header className="site-header">
      <a className="brand-lockup" href="/" aria-label="FalconDeck home">
        <img src="/logomark-mark-light.svg" alt="" />
        <span>FalconDeck</span>
      </a>
    </header>
  )
}

function SiteFooter() {
  return (
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
        <a href={PRIVACY_URL}>Privacy</a>
        <a href={TERMS_URL}>Terms</a>
      </div>
    </footer>
  )
}

function LegalPage({ page }: { page: 'privacy' | 'terms' }) {
  const isPrivacy = page === 'privacy'
  return (
    <div className="site-frame">
      <div className="site-rail site-rail--left" aria-hidden="true" />
      <div className="site-rail site-rail--right" aria-hidden="true" />
      <SiteHeader />
      <main className="legal-page">
        <p className="eyebrow">FalconDeck</p>
        <h1>{isPrivacy ? 'Privacy Policy' : 'Terms of Use'}</h1>
        <p className="legal-page__updated">Effective 25 August 2026</p>
        {isPrivacy ? <PrivacyPolicy /> : <TermsOfUse />}
      </main>
      <SiteFooter />
    </div>
  )
}

function PrivacyPolicy() {
  return (
    <div className="legal-copy">
      <p>FalconDeck is made available by Version Zero Limited ("we", "us"). This policy explains how the FalconDeck mobile app, desktop app, relay, and website handle information. Contact us about privacy at <a href="mailto:ops@falcondeck.com">ops@falcondeck.com</a>.</p>
      <h2>What FalconDeck processes</h2>
      <p>FalconDeck connects a phone or browser to the FalconDeck daemon and coding agents running on your computer. The app can display and send agent-session content, including thread titles, prompts, responses, code snippets, tool activity, files or images you choose to attach, and approval or follow-up instructions. That content remains in your underlying coding-agent and local computer storage; FalconDeck does not operate a hosted plaintext conversation database.</p>
      <p>To make remote access work, the relay processes device and session identifiers, connection and routing metadata, IP-address-level network information, and encrypted session updates. It retains encrypted update envelopes for replay after a reconnect. The relay cannot read the encrypted session content. You can use a relay that you operate instead of the hosted relay.</p>
      <h2>Notifications and optional features</h2>
      <p>If you enable notifications, FalconDeck stores a push token with the relay. A notification can include a thread title so that the relay, Expo Push Service, and your device notification service can route and display it. Notifications do not include a transcript or message preview.</p>
      <p>The app may use the microphone for dictation, the camera or photo library to attach an image, and on-device speech recognition when you choose those features. These inputs stay on your device unless you send them in a message or request transcription.</p>
      <p>If you choose cloud transcription in the paired desktop app, the recording is sent end-to-end encrypted to your paired daemon. The daemon sends it to the transcription provider you selected and configured (for example, through OpenRouter). That provider handles the audio under its own terms and privacy policy. FalconDeck does not receive or store your provider credential; it stays in the operating-system credential store on your paired computer.</p>
      <h2>How information is used and shared</h2>
      <p>We use the information above only to provide remote control, synchronization, notifications, security, and support. We do not sell personal information, run advertising, or use agent-session content for advertising or training. Information is shared only with the services needed for the features you choose: the hosted relay (encrypted content and routing data), Expo Push Service (push token and notification title), Apple or your platform notification service, and your selected transcription provider for cloud transcription.</p>
      <h2>Storage, retention, and security</h2>
      <p>The mobile app stores its pairing material and a local encrypted connection/cache state on the device. The hosted relay keeps encrypted replay data for service continuity; it may be pruned, after which the app refreshes from your daemon. Your underlying agent and desktop determine retention of the original session content. Recordings remain on the phone until a transcription succeeds; a failed or cancelled transcription can leave the recording available to retry or discard.</p>
      <p>FalconDeck uses end-to-end encryption for session content between paired devices. No transmission or storage system is completely secure, and you should protect pairing links, device access, and your chosen service credentials.</p>
      <h2>Your choices</h2>
      <p>You can decline permissions, disable notifications in the app or device settings, delete the app’s local data by uninstalling it, disconnect paired devices from FalconDeck, and self-host the relay. For access, deletion, or other privacy requests relating to the hosted relay, email <a href="mailto:ops@falcondeck.com">ops@falcondeck.com</a>. We may need enough information to identify the relevant encrypted session or device.</p>
      <h2>Changes and children</h2>
      <p>We may update this policy as FalconDeck changes and will publish the revised version here. FalconDeck is a developer tool and is not directed to children.</p>
    </div>
  )
}

function TermsOfUse() {
  return (
    <div className="legal-copy">
      <p>These Terms of Use govern your use of FalconDeck, provided by Version Zero Limited ("we", "us"). By downloading or using FalconDeck, you agree to these terms and the <a href={PRIVACY_URL}>Privacy Policy</a>.</p>
      <h2>The service</h2>
      <p>FalconDeck is a developer tool that connects to coding agents and a daemon you control. You are responsible for your devices, accounts, prompts, code, agent configuration, and any actions you approve or initiate through FalconDeck. FalconDeck does not provide coding, legal, security, or operational advice.</p>
      <h2>Acceptable use</h2>
      <p>Do not use FalconDeck to violate law, infringe rights, interfere with the relay or other users, bypass security controls, or transmit material you do not have the right to handle. Keep pairing links and device credentials secret. You must comply with the terms of the coding-agent, model, hosting, and transcription services you choose to use.</p>
      <h2>Third-party services and open source</h2>
      <p>FalconDeck can work with third-party coding agents, model providers, notification services, and optional transcription providers. Those services are governed by their own terms and privacy policies. FalconDeck is open source under its repository license; those license terms apply to the source code.</p>
      <h2>Availability and changes</h2>
      <p>FalconDeck and the hosted relay are provided on an "as is" and "as available" basis. We may modify, suspend, or discontinue features. You can self-host a compatible relay if you prefer to control that infrastructure.</p>
      <h2>Liability</h2>
      <p>To the extent permitted by law, we are not liable for indirect, incidental, special, consequential, or punitive damages, or for loss of data, code, profits, or business opportunity arising from use of FalconDeck. Nothing in these terms excludes liability that cannot legally be excluded.</p>
      <h2>Contact and changes</h2>
      <p>Questions about these terms can be sent to <a href="mailto:ops@falcondeck.com">ops@falcondeck.com</a>. We may update these terms by posting a revised version here; continued use after the effective date means you accept the revised terms.</p>
    </div>
  )
}

/** The key badges in the hero are real: `d` downloads, `s` opens the source. */
function useKeyShortcuts(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return

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
  }, [enabled])
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
  const path = window.location.pathname.replace(/\/+$/, '') || '/'
  const isLegalPage = path === PRIVACY_URL || path === TERMS_URL
  useKeyShortcuts(!isLegalPage)
  if (path === PRIVACY_URL) return <LegalPage page="privacy" />
  if (path === TERMS_URL) return <LegalPage page="terms" />

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

      <SiteFooter />
    </div>
  )
}

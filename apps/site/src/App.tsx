import { lazy, Suspense, useEffect, type ReactNode } from 'react'

import { Check, ChevronLeft, ChevronRight, CircleDot, Code2, Download, Github, Smartphone, Zap } from 'lucide-react'
import { ProductFeatures } from './ProductFeatures'

// Internal design playground; dev server only, never in the production bundle.
const QAPromptPlayground = import.meta.env.DEV ? lazy(() => import('./qa-prompt-playground')) : null

const REPO_URL = 'https://github.com/jamesblackwell/falcondeck'
const RELEASES_URL = 'https://github.com/jamesblackwell/falcondeck/releases'
const PAIR_URL = '/pair'
const PAIRING_APP_SCHEME = 'falcondeck'
const IOS_APP_STORE_URL = 'https://apps.apple.com/app/falcondeck/id6760899257'
const SELF_HOSTING_URL = 'https://github.com/jamesblackwell/falcondeck/blob/main/docs/SELF-HOSTING.md'
const GETTING_STARTED_URL = 'https://github.com/jamesblackwell/falcondeck/blob/main/docs/GETTING-STARTED.md'
const DISCUSSIONS_URL = `${REPO_URL}/discussions`
const PRIVACY_URL = '/privacy'
const TERMS_URL = '/terms'
const QA_PROMPT_URL = '/qa-prompt'

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
        <small>A free, open-source workspace for your coding agents.</small>
      </div>
      <div className="site-footer__links">
        <a href={REPO_URL}>GitHub</a>
        <a href={RELEASES_URL}>Releases</a>
        <a href={GETTING_STARTED_URL}>Get started</a>
        <a href={DISCUSSIONS_URL}>Feedback</a>
        <a className="fd-focus" href={IOS_APP_STORE_URL}>Download for iOS</a>
        <a href={PRIVACY_URL}>Privacy</a>
        <a href={TERMS_URL}>Terms</a>
      </div>
    </footer>
  )
}

function pairingAppUrlFromSearch(search: URLSearchParams) {
  const code = search.get('code')?.trim()
  const params = new URLSearchParams()
  if (code) params.set('code', code)
  const relay = search.get('relay')?.trim()
  if (relay) params.set('relay', relay)
  const query = params.toString()
  return query ? `${PAIRING_APP_SCHEME}://pair?${query}` : `${PAIRING_APP_SCHEME}://pair`
}

function PairPage() {
  const search = new URLSearchParams(window.location.search)
  const hasPairingCode = Boolean(search.get('code')?.trim())
  const appUrl = pairingAppUrlFromSearch(search)

  useEffect(() => {
    const previousTitle = document.title
    document.title = 'Open FalconDeck'
    const robots = document.createElement('meta')
    robots.name = 'robots'
    robots.content = 'noindex'
    document.head.appendChild(robots)
    return () => {
      document.title = previousTitle
      robots.remove()
    }
  }, [])

  useEffect(() => {
    if (!hasPairingCode) return
    if (!/iPhone|iPad|iPod|Android/i.test(navigator.userAgent)) return
    const timer = window.setTimeout(() => {
      window.location.href = appUrl
    }, 80)
    return () => window.clearTimeout(timer)
  }, [appUrl, hasPairingCode])

  return (
    <div className="site-frame">
      <div className="site-rail site-rail--left" aria-hidden="true" />
      <div className="site-rail site-rail--right" aria-hidden="true" />
      <SiteHeader />
      <main className="pair-page">
        <p className="eyebrow">FalconDeck</p>
        <h1>{hasPairingCode ? 'Connect to your Mac' : 'Get FalconDeck for iOS'}</h1>
        <p className="pair-page__lede">
          {hasPairingCode
            ? 'Open this pairing link in FalconDeck on your iPhone or iPad to join your Mac’s live session.'
            : 'Download the free iPhone and iPad app, then scan the pairing QR code from FalconDeck on your Mac.'}
        </p>
        <div className="pair-page__actions">
          {hasPairingCode && (
            <a className="btn btn--accent fd-focus" href={appUrl}>
              <Smartphone aria-hidden="true" />
              Open FalconDeck
            </a>
          )}
          <a className={`btn ${hasPairingCode ? 'btn--outline' : 'btn--accent'} fd-focus`} href={IOS_APP_STORE_URL}>
            <Download aria-hidden="true" />
            Download on the App Store
          </a>
        </div>
        <p className="pair-page__fallback">
          {hasPairingCode ? (
            'After installing the app, scan a fresh pairing QR code from your Mac.'
          ) : (
            <>Already installed? <a className="fd-focus" href={appUrl}>Open FalconDeck</a>.</>
          )}
        </p>
      </main>
      <SiteFooter />
    </div>
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
        <p className="legal-page__updated">Effective {isPrivacy ? '5 October 2026' : '25 August 2026'}</p>
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
      <p>The app may use the microphone for dictation, the camera or photo library to attach an image, and on-device speech recognition when you choose those features. These inputs stay on your device unless you send them in a message or use an optional cloud feature.</p>
      <p>Optional OpenRouter features send the content needed for the action you request: recordings for cloud transcription, selected text and an editing instruction for voice rewrite, a short conversation excerpt for title suggestions, or an agent reply for Read Aloud. Recordings from your phone are sent end-to-end encrypted to your paired computer before it sends them to OpenRouter. OpenRouter and the selected model provider handle this content under their own terms and privacy policies. Your provider key stays in the operating-system credential store on your connected computer; paired devices do not receive it.</p>
      <h2>How information is used and shared</h2>
      <p>We use the information above only to provide remote control, synchronization, notifications, security, and support. We do not sell personal information, run advertising, or use agent-session content for advertising or training. Information is shared only with the services needed for the features you choose: the hosted relay (encrypted content and routing data), Expo Push Service (push token and notification title), Apple or your platform notification service, and OpenRouter and selected model providers for optional cloud speech and writing features.</p>
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
          falcondeck / workspace
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

          <p className="mock-label mock-label--spaced">Tasks</p>
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
              <p className="mock-label">Task · Claude</p>
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

export default function App({ location = window.location }: { location?: Pick<Location, 'pathname' | 'search'> }) {
  const path = location.pathname.replace(/\/+$/, '') || '/'
  const search = new URLSearchParams(location.search)
  const isPairPage = path === PAIR_URL || (path === '/' && Boolean(search.get('code')?.trim()))
  const isLegalPage = path === PRIVACY_URL || path === TERMS_URL
  const isPlaygroundPage = QAPromptPlayground !== null && path === QA_PROMPT_URL
  useKeyShortcuts(!isLegalPage && !isPairPage && !isPlaygroundPage)
  if (path === PRIVACY_URL) return <LegalPage page="privacy" />
  if (path === TERMS_URL) return <LegalPage page="terms" />
  if (isPlaygroundPage && QAPromptPlayground) {
    return (
      <Suspense fallback={null}>
        <QAPromptPlayground />
      </Suspense>
    )
  }
  if (isPairPage) return <PairPage />

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
          <a href="#features">Features</a>
          <a href="#security">Security</a>
          <a href="#agents">Agents</a>
          <a href="#get-started">Get started</a>
        </nav>
        <div className="site-header__actions">
          <a className="btn btn--outline btn--sm fd-focus" href={IOS_APP_STORE_URL}>
            <Smartphone aria-hidden="true" />
            iOS app
          </a>
          <a className="btn btn--accent btn--sm desktop-download fd-focus" href={RELEASES_URL}>
            Download for Mac
            <KeyBadge>D</KeyBadge>
          </a>
        </div>
      </header>

      <main>
        <section className="hero" id="top">
          <p className="eyebrow">
            <span className="status-dot" />
            Free and open source · built for everyday work
          </p>
          <h1>
            <span>Your coding agents.</span> <span>A proper Mac app.</span>
          </h1>
          <p className="hero__lede">
            Bring Codex, Claude Code, OpenCode, and your projects into one comfortable workspace.
            Keep your existing accounts and favourite editor. When you step away from your Mac,
            follow the same live work from your iPhone or iPad.
          </p>
          <div className="hero__actions">
            <a className="btn btn--accent fd-focus" href={RELEASES_URL}>
              <Download aria-hidden="true" />
              Download for Mac
              <KeyBadge>D</KeyBadge>
            </a>
            <a className="btn btn--outline fd-focus" href={IOS_APP_STORE_URL}>
              <Smartphone aria-hidden="true" />
              Download on the App Store
            </a>
          </div>
          <p className="hero__source">
            <a className="text-link fd-focus" href={REPO_URL}>
              <Github aria-hidden="true" />
              Star on GitHub
              <KeyBadge variant="ghost">S</KeyBadge>
            </a>
          </p>
          <p className="hero__footnote">Mac · iPhone · iPad · free and open source</p>
        </section>

        <section className="features" id="product">
          <Feature title="A calmer workspace">
            Keep projects, conversations, tool activity, approvals, and changes together.
            Spend less time juggling terminal windows and more time moving your work forward.
          </Feature>
          <Feature title="Your tools, your choice">
            Choose the right agent for each task and use the accounts you already have.
            Your code stays in your folders, and the whole FalconDeck stack is MIT licensed.
          </Feature>
          <Feature title="Keep work moving">
            Step away from your desk without losing the conversation. Read responses, answer questions,
            approve actions, and send the next instruction from your phone.
          </Feature>
        </section>

        <section className="showcase">
          <div className="showcase__caption">
            <p>One workspace · at your desk or on your phone</p>
            <p className="showcase__status">
              <span className="status-dot" />
              Desktop connected
            </p>
          </div>
          <div className="showcase__stage">
            <div className="showcase__desktop">
              <DesktopMock />
            </div>
            <PhoneMock />
          </div>
        </section>

        <ProductFeatures />

        <section className="mobile-download" id="get-started" aria-labelledby="get-started-heading">
          <div>
            <p className="eyebrow">Start with your Mac</p>
            <h2 id="get-started-heading">From download to first task.</h2>
            <p>
              Connect a project you already work on and use your existing agent account.
              The Mac app works on its own; pair your phone whenever you want.
            </p>
            <a className="text-link fd-focus" href={GETTING_STARTED_URL}>
              Read the getting-started guide <ChevronRight aria-hidden="true" />
            </a>
          </div>
          <ol className="mobile-download__steps">
            <li><strong>Install FalconDeck</strong><p>Download the Apple Silicon or Intel DMG and drag the app into Applications. Requires macOS 12 or later.</p></li>
            <li><strong>Choose your agent and project</strong><p>Setup checks your coding tools and helps you choose a folder. Sign in with the agent account you already use.</p></li>
            <li><strong>Try a small task</strong><p>Ask your agent to explain the project and how to run its tests. Follow its work and respond to questions in the app.</p></li>
          </ol>
        </section>

        <section className="mobile-download" id="ios" aria-labelledby="ios-heading">
          <div>
            <p className="eyebrow">Available on the App Store</p>
            <h2 id="ios-heading">FalconDeck for iPhone and iPad</h2>
            <p>
              Step away from your desk and keep your agents moving. Read responses, review changes,
              answer questions, and approve actions from the same live session.
            </p>
            <a className="btn btn--accent fd-focus" href={IOS_APP_STORE_URL}>
              <Smartphone aria-hidden="true" />
              Download on the App Store
            </a>
          </div>
          <ol className="mobile-download__steps">
            <li>
              <strong>Install the Mac and iOS apps</strong>
              <p>Download FalconDeck for your Mac and get the free app on your iPhone or iPad.</p>
            </li>
            <li>
              <strong>Pair your device</strong>
              <p>On your Mac, open Settings → Remote Access. Scan the QR code with the iOS app.</p>
            </li>
            <li>
              <strong>Continue from anywhere</strong>
              <p>Your projects and agent work are ready on your phone. No FalconDeck account needed.</p>
            </li>
          </ol>
        </section>

        <section className="harnesses" id="agents">
          <p className="harnesses__label">Works with</p>
          <div className="harnesses__list">
            <span>Codex</span>
            <span>Claude Code</span>
            <span>OpenCode</span>
            <span>Pi</span>
            <span className="harnesses__more">+ other compatible agents</span>
          </div>
        </section>

        <section className="site-faq" aria-labelledby="faq-heading">
          <h2 id="faq-heading">A few things to know</h2>
          <details><summary>Is FalconDeck free?</summary><p>Yes. The Mac app, iPhone and iPad app, and hosted relay are free. Your coding agent’s usual subscription or provider charges still apply. Optional OpenRouter features use your own key and are billed by OpenRouter.</p></details>
          <details><summary>What does OpenRouter power?</summary><p>Optional cloud transcription, voice rewrite, title suggestions, and Read Aloud. Add your own key in Settings → Speech on your Mac. These features send the audio or text needed for the action to the provider. Mac dictation can also use on-device Apple Speech.</p></details>
          <details><summary>Do I need to change editors or move my code?</summary><p>No. Connect your existing project folders and keep using your favourite editor. FalconDeck gives your coding agents a workspace alongside it.</p></details>
          <details><summary>Does my Mac need to stay on?</summary><p>For work running on your Mac, keep it awake, online, and running FalconDeck. You can also run agents on another machine over SSH for an always-on setup.</p></details>
          <details><summary>Where does my work live?</summary><p>Your code stays in your folders, and your coding agents own their sessions. Remote session content is end-to-end encrypted between your paired devices. You can use the free hosted relay or run your own.</p></details>
          <details><summary>How mature is it?</summary><p>FalconDeck is early, actively developed, and already used for daily coding work. Try it on a real project and <a href={DISCUSSIONS_URL}>tell us what would make your workflow better</a>.</p></details>
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

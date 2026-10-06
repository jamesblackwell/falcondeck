import { lazy, Suspense, useEffect, type ReactNode } from 'react'

import { Check, ChevronRight, Download, Github, Smartphone } from 'lucide-react'
import { ProductFeatures } from './ProductFeatures'
import { Harnesses } from './Harnesses'
import { ProductShowcase } from './ProductShowcase'

// Internal design playground; dev server only, never in the production bundle.
const QAPromptPlayground = import.meta.env.DEV ? lazy(() => import('./qa-prompt-playground')) : null

const REPO_URL = 'https://github.com/jamesblackwell/falcondeck'
const RELEASES_URL = 'https://github.com/jamesblackwell/falcondeck/releases'
const MAC_APPLE_SILICON_URL = `${RELEASES_URL}/latest/download/FalconDeck_aarch64.dmg`
const MAC_INTEL_URL = `${RELEASES_URL}/latest/download/FalconDeck_x64.dmg`
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
      if (key === 'd') window.location.href = MAC_APPLE_SILICON_URL
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
          <a className="btn btn--accent btn--sm desktop-download fd-focus" href={MAC_APPLE_SILICON_URL}>
            Download for Mac
            <KeyBadge>D</KeyBadge>
          </a>
        </div>
      </header>

      <main>
        <section className="hero" id="top">
          <p className="eyebrow">
            <span className="status-dot" />
            Free and open source
          </p>
          <h1>
            <span>Your coding agents.</span> <span>A proper Mac app.</span>
          </h1>
          <p className="hero__lede">
            Every coding agent you use, in one calm workspace, on the accounts you already have.
            Step away and carry on from your iPhone.
          </p>
          <div className="hero__actions">
            <a className="btn btn--accent fd-focus" href={MAC_APPLE_SILICON_URL}>
              <Download aria-hidden="true" />
              Download for Mac
              <KeyBadge>D</KeyBadge>
            </a>
            <a className="btn btn--outline fd-focus" href={IOS_APP_STORE_URL}>
              <Smartphone aria-hidden="true" />
              Download on the App Store
            </a>
          </div>
          <p className="hero__download-options">
            <span>Apple silicon (M1 or later)</span>
            <span aria-hidden="true">·</span>
            <a className="text-link fd-focus" href={MAC_INTEL_URL}>Intel Mac</a>
            <span aria-hidden="true">·</span>
            <a className="text-link fd-focus" href={REPO_URL}>
              <Github aria-hidden="true" />
              Star on GitHub
              <KeyBadge variant="ghost">S</KeyBadge>
            </a>
          </p>
          <Harnesses />
        </section>

        <ProductShowcase />

        <section className="features" id="product">
          <Feature title="A calmer workspace">
            Projects, conversations, approvals, and diffs in one window instead of a pile of terminals.
          </Feature>
          <Feature title="Your tools, your choice">
            Pick the right agent for each task. Your code stays in your folders, and FalconDeck is MIT licensed.
          </Feature>
          <Feature title="Keep work moving">
            Read replies, answer questions, and approve actions from your phone, live and end-to-end encrypted.
          </Feature>
        </section>

        <ProductFeatures />

        <section className="mobile-download" id="get-started" aria-labelledby="get-started-heading">
          <div>
            <p className="eyebrow">Start with your Mac</p>
            <h2 id="get-started-heading">From download to first task.</h2>
            <p>Open a project you already work on and sign in with your usual agent account. Pairing a phone is optional.</p>
            <a className="text-link fd-focus" href={GETTING_STARTED_URL}>
              Read the getting-started guide <ChevronRight aria-hidden="true" />
            </a>
          </div>
          <ol className="mobile-download__steps">
            <li><strong>Install FalconDeck</strong><p>Drag the app into Applications. macOS 12 or later.</p></li>
            <li><strong>Choose an agent and a project</strong><p>Setup finds your coding tools and helps you pick a folder.</p></li>
            <li><strong>Try a small task</strong><p>Ask your agent to explain the project and run its tests.</p></li>
          </ol>
        </section>

        <section className="mobile-download" id="ios" aria-labelledby="ios-heading">
          <div>
            <p className="eyebrow">Available on the App Store</p>
            <h2 id="ios-heading">FalconDeck for iPhone and iPad</h2>
            <p>Read responses, review changes, and approve actions in the same live session, away from your desk.</p>
            <a className="btn btn--accent fd-focus" href={IOS_APP_STORE_URL}>
              <Smartphone aria-hidden="true" />
              Download on the App Store
            </a>
          </div>
          <ol className="mobile-download__steps">
            <li>
              <strong>Install both apps</strong>
              <p>FalconDeck on your Mac, and the free app on your iPhone or iPad.</p>
            </li>
            <li>
              <strong>Pair your device</strong>
              <p>On your Mac, open Settings → Remote Access and scan the QR code.</p>
            </li>
            <li>
              <strong>Carry on anywhere</strong>
              <p>Your projects and sessions are on your phone. No FalconDeck account needed.</p>
            </li>
          </ol>
        </section>

        <section className="site-faq" aria-labelledby="faq-heading">
          <h2 id="faq-heading">A few things to know</h2>
          <details><summary>Is FalconDeck free?</summary><p>Yes. The apps and the hosted relay are free. Your agent’s own subscription still applies, and optional OpenRouter features bill your own key.</p></details>
          <details><summary>What does OpenRouter power?</summary><p>Optional cloud transcription, voice rewrite, title suggestions, and Read Aloud. Add your key in Settings → Speech on your Mac; only the audio or text for that action is sent. Dictation can also run on-device with Apple Speech.</p></details>
          <details><summary>Do I need to change editors or move my code?</summary><p>No. Open your existing folders and keep your editor. FalconDeck sits alongside it.</p></details>
          <details><summary>Does my Mac need to stay on?</summary><p>For work on your Mac, keep it awake and online with FalconDeck running. For an always-on setup, run agents on another machine over SSH.</p></details>
          <details><summary>Where does my work live?</summary><p>Your code stays in your folders and your agents own their sessions. Remote traffic is end-to-end encrypted between paired devices, through our free relay or your own.</p></details>
          <details><summary>How mature is it?</summary><p>Early, actively developed, and used for real work every day. Try it on a project and <a href={DISCUSSIONS_URL}>tell us what would help</a>.</p></details>
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

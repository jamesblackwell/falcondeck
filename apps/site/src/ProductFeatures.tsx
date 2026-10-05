import type { ReactNode } from 'react'
import {
  Bell, Check, CheckCheck, Clock3, Code2, Folder, GitCompareArrows, KeyRound,
  Mic, Monitor, Palette, Play, Plug, ShieldCheck, Volume2,
} from 'lucide-react'

function FeatureCard({
  label, title, children, preview,
}: { label: string; title: string; children: ReactNode; preview: ReactNode }) {
  return (
    <article className="product-feature">
      <div className="product-feature__preview" aria-hidden="true">{preview}</div>
      <p className="eyebrow">{label}</p>
      <h3>{title}</h3>
      <p className="product-feature__description">{children}</p>
    </article>
  )
}

function AgentPreview() {
  return (
    <div className="feature-preview">
      <div className="feature-preview__bar"><Folder /> Your projects</div>
      <div className="feature-preview__task">
        <span><strong>Build the settings page</strong><small>Website · Codex</small></span>
        <span className="feature-preview__state"><span className="status-dot" /> Running</span>
      </div>
      <div className="feature-preview__task">
        <span><strong>Check the iOS layout</strong><small>Mobile · Claude Code</small></span>
        <span className="feature-preview__state"><CheckCheck /> Ready</span>
      </div>
      <div className="feature-preview__task">
        <span><strong>Explain the API</strong><small>Server · OpenCode</small></span>
        <span className="feature-preview__state"><span className="status-dot" /> Running</span>
      </div>
    </div>
  )
}

function ReviewPreview() {
  return (
    <div className="feature-preview">
      <div className="feature-preview__bar"><GitCompareArrows /> src/settings.ts</div>
      <div className="feature-preview__diff">
        <code className="feature-preview__removed">− timeout: 1000,</code>
        <code className="feature-preview__added">+ timeout: 5000,</code>
      </div>
      <div className="feature-preview__approval">
        <span><ShieldCheck /> Run the tests?</span>
        <span className="feature-preview__pill">Approve</span>
      </div>
    </div>
  )
}

function DictationPreview() {
  return (
    <div className="feature-preview">
      <div className="feature-preview__bar"><Mic /> Hold to dictate</div>
      <div className="feature-preview__waveform">
        {[12, 20, 32, 16, 40, 28, 48, 24, 36, 16, 28, 44, 20, 32, 12].map((height, i) => (
          <span key={i} style={{ height }} />
        ))}
      </div>
      <p className="feature-preview__transcript">“Make this paragraph a little shorter.”</p>
      <div className="feature-preview__tags"><span>Apple Speech</span><span>OpenRouter</span></div>
    </div>
  )
}

function ReadAloudPreview() {
  return (
    <div className="feature-preview">
      <div className="feature-preview__bar"><Volume2 /> Read Aloud</div>
      <p className="feature-preview__response">The change is ready. All tests pass, and the settings now save correctly.</p>
      <div className="feature-preview__player">
        <span className="feature-preview__play"><Play /></span>
        <span className="feature-preview__track"><span /></span>
        <span>0:12</span>
      </div>
      <div className="feature-preview__tags"><span>Mac</span><span>iPhone</span><span>iPad</span></div>
    </div>
  )
}

function OpenRouterPreview() {
  return (
    <div className="feature-preview">
      <div className="feature-preview__bar"><KeyRound /> OpenRouter <span className="feature-preview__connected"><Check /> Key configured</span></div>
      <div className="feature-preview__setting"><span>Cloud transcription</span><Mic /></div>
      <div className="feature-preview__setting"><span>Voice rewrite</span><Code2 /></div>
      <div className="feature-preview__setting"><span>Title suggestions</span><CheckCheck /></div>
    </div>
  )
}

function AutomationPreview() {
  return (
    <div className="feature-preview">
      <div className="feature-preview__bar"><Clock3 /> Automations</div>
      <div className="feature-preview__schedule">
        <strong>Check the tests each morning</strong>
        <span className="feature-preview__pill">Daily · 09:00</span>
      </div>
      <div className="feature-preview__setting"><span>Last run</span><span className="feature-preview__connected"><Check /> Complete</span></div>
      <div className="feature-preview__setting"><span>Next run</span><span>Tomorrow</span></div>
    </div>
  )
}

const essentials = [
  {
    icon: Bell,
    title: 'Know when you’re needed',
    description: 'Choose notifications for completed work, questions, approvals, and errors on your Mac and phone.',
  },
  {
    icon: Monitor,
    title: 'Let agents use your computer',
    description: 'On macOS 14 or later, enable browser and native app tasks with permissions you control.',
  },
  {
    icon: Plug,
    title: 'Connect your tools',
    description: 'Bring MCP tools and agent skills, and organise work with built-in Notes and Kanban extensions.',
  },
  {
    icon: Palette,
    title: 'Make the workspace yours',
    description: 'Choose themes, fonts, text sizes, and keyboard shortcuts that suit the way you work.',
  },
]

export function ProductFeatures() {
  return (
    <section className="product-features" id="features" aria-labelledby="features-heading">
      <div className="product-features__intro">
        <p className="eyebrow">Made for daily work</p>
        <h2 id="features-heading">From the first prompt to the final review.</h2>
        <p>Run your agents, inspect their work, talk through the next step, and keep regular tasks on schedule. All in the same workspace.</p>
      </div>
      <div className="product-features__grid">
        <FeatureCard label="Projects & agents" title="Work with agents side by side" preview={<AgentPreview />}>
          Run Codex, Claude Code, OpenCode, and other supported agents across your projects.
          Keep your existing accounts, choose models, and hand a task to another agent with its context.
        </FeatureCard>
        <FeatureCard label="Files & review" title="See what changed and why" preview={<ReviewPreview />}>
          Browse files, inspect diffs, preview Markdown and media, and open a built-in terminal.
          Answer questions and review permission requests with the task’s context in view.
        </FeatureCard>
        <FeatureCard label="System-wide dictation" title="Use your voice across your Mac" preview={<DictationPreview />}>
          Hold a shortcut to dictate into any Mac app. Use on-device Apple Speech or OpenRouter,
          and rewrite selected text with a spoken instruction.
        </FeatureCard>
        <FeatureCard label="Text-to-speech" title="Listen to your agent’s replies" preview={<ReadAloudPreview />}>
          Play responses aloud on your Mac, iPhone, or iPad. Read Aloud uses OpenRouter
          text-to-speech, with your key configured on your Mac.
        </FeatureCard>
        <FeatureCard label="OpenRouter integration" title="Bring your own key and models" preview={<OpenRouterPreview />}>
          Choose cloud transcription and voice rewrite models, and request title suggestions.
          Your OpenRouter key stays in your Mac’s secure credential store. Provider usage is billed to you.
        </FeatureCard>
        <FeatureCard label="Automations" title="Put regular work on a schedule" preview={<AutomationPreview />}>
          Schedule recurring instructions or a one-off follow-up. Runs appear as normal tasks
          on your Mac or a configured SSH host while that computer stays awake and online.
        </FeatureCard>
      </div>
      <ul className="product-features__essentials">
        {essentials.map(({ icon: Icon, title, description }) => (
          <li key={title}>
            <Icon aria-hidden="true" />
            <div><h3>{title}</h3><p>{description}</p></div>
          </li>
        ))}
      </ul>
    </section>
  )
}

import { ArrowRight, Github, Monitor, Smartphone, Shield, Terminal, Zap, Radio } from 'lucide-react'
import { Button } from '@falcondeck/ui'

function FeatureCard({ icon, title, description }: { icon: React.ReactNode; title: string; description: string }) {
  return (
    <div className="rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 p-6">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-[var(--fd-radius-lg)] bg-surface-3 text-fg-tertiary">
        {icon}
      </div>
      <h3 className="text-[length:var(--fd-text-md)] font-semibold text-fg-primary">{title}</h3>
      <p className="mt-2 text-[length:var(--fd-text-sm)] leading-relaxed text-fg-tertiary">{description}</p>
    </div>
  )
}

export default function App() {
  return (
    <div className="min-h-screen bg-surface-0">
      {/* Nav */}
      <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
        <div className="flex items-center gap-2">
          <Terminal className="h-5 w-5 text-accent" />
          <span className="text-[length:var(--fd-text-md)] font-semibold text-fg-primary">FalconDeck</span>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <a href="https://github.com/jamesblackwell/falcondeck">
              <Github className="h-4 w-4" />
              GitHub
            </a>
          </Button>
          <Button size="sm" asChild>
            <a href="https://app.falcondeck.com">
              Open App
              <ArrowRight className="h-3.5 w-3.5" />
            </a>
          </Button>
        </div>
      </nav>

      {/* Hero */}
      <section className="mx-auto max-w-5xl px-6 pt-16 pb-20">
        <div className="max-w-3xl">
          <h1 className="text-[length:var(--fd-text-3xl)] font-semibold leading-tight tracking-tight text-fg-primary md:text-5xl md:leading-tight">
            The open-source control plane for AI coding agents
          </h1>
          <p className="mt-4 max-w-2xl text-[length:var(--fd-text-lg)] leading-relaxed text-fg-tertiary">
            Manage Codex workspaces, review diffs, approve actions, and monitor sessions — from your desktop or remotely from any device.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Button size="lg" asChild>
              <a href="https://github.com/jamesblackwell/falcondeck">
                <Github className="h-4 w-4" />
                View on GitHub
              </a>
            </Button>
            <Button variant="outline" size="lg" asChild>
              <a href="https://app.falcondeck.com">
                Open Remote Client
                <ArrowRight className="h-4 w-4" />
              </a>
            </Button>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-5xl px-6 pb-20">
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <FeatureCard
            icon={<Monitor className="h-5 w-5" />}
            title="Desktop control plane"
            description="A native Tauri app with grouped project navigation, rich conversation rendering, and real-time streaming."
          />
          <FeatureCard
            icon={<Smartphone className="h-5 w-5" />}
            title="Remote access"
            description="Pair your desktop with a phone or browser. Follow live sessions, send prompts, and approve actions from anywhere."
          />
          <FeatureCard
            icon={<Shield className="h-5 w-5" />}
            title="End-to-end encrypted"
            description="All remote session content is encrypted client-to-client. The relay server never sees plaintext."
          />
          <FeatureCard
            icon={<Zap className="h-5 w-5" />}
            title="Approvals & diffs"
            description="Review Codex permission requests and code changes inline. Approve or deny with a single click."
          />
          <FeatureCard
            icon={<Radio className="h-5 w-5" />}
            title="Public relay"
            description="A lightweight relay server handles session bridging, QR pairing, and reconnection by sequence number."
          />
          <FeatureCard
            icon={<Terminal className="h-5 w-5" />}
            title="Open source"
            description="MIT licensed. The full stack — daemon, relay, desktop app, remote client — is in a single monorepo."
          />
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border-subtle">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-6">
          <p className="text-[length:var(--fd-text-xs)] text-fg-muted">FalconDeck</p>
          <a
            href="https://github.com/jamesblackwell/falcondeck"
            className="text-[length:var(--fd-text-xs)] text-fg-muted transition-colors hover:text-fg-secondary"
          >
            GitHub
          </a>
        </div>
      </footer>
    </div>
  )
}

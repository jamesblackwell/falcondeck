import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@falcondeck/ui'

export default function App() {
  return (
    <main className="min-h-screen px-6 py-10 text-white md:px-10">
      <section className="mx-auto flex max-w-6xl flex-col gap-8">
        <div className="space-y-4">
          <p className="text-sm uppercase tracking-[0.4em] text-zinc-400">FalconDeck</p>
          <h1 className="max-w-4xl text-5xl font-semibold tracking-tight md:text-7xl">
            Control Codex sessions locally, remotely, and eventually from mobile.
          </h1>
          <p className="max-w-2xl text-lg text-zinc-400">
            FalconDeck is the open-source agent control plane for managing Codex workspaces,
            approvals, diffs, and remote access from one interface.
          </p>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <a href="https://app.falcondeck.com">Open remote app</a>
            </Button>
            <Button variant="secondary" asChild>
              <a href="https://github.com/Dimillian/CodexMonitor">Design reference</a>
            </Button>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {[
            ['Desktop control plane', 'Grouped projects, rich chat UX, approvals, plan, and diff views.'],
            ['Public relay', 'Pair a desktop with a phone or browser through a hosted relay.'],
            ['React Native-ready core', 'Shared headless state and protocol layers prepared for future native clients.'],
          ].map(([title, description]) => (
            <Card key={title}>
              <CardHeader>
                <CardTitle>{title}</CardTitle>
                <CardDescription>{description}</CardDescription>
              </CardHeader>
              <CardContent />
            </Card>
          ))}
        </div>
      </section>
    </main>
  )
}

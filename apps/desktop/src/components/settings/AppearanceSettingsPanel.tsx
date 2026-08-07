import { AppearanceControls, Card, CardContent, CardDescription, CardHeader, CardTitle } from '@falcondeck/ui'

export function AppearanceSettingsPanel() {
  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-[length:var(--fd-text-xs)] uppercase tracking-[0.24em] text-fg-muted">
          Settings
        </p>
        <h1 className="text-[length:var(--fd-text-2xl)] font-semibold text-fg-primary">
          Appearance
        </h1>
        <p className="max-w-2xl text-[length:var(--fd-text-sm)] text-fg-tertiary">
          These preferences are stored on this device, so each machine can match its own display
          and system theme.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Theme &amp; Type</CardTitle>
          <CardDescription>
            Switch between light and dark, or let FalconDeck follow the system automatically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AppearanceControls />
        </CardContent>
      </Card>
    </div>
  )
}

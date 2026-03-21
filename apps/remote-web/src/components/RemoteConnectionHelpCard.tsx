import { Button, Panel, PanelContent, PanelHeader } from '@falcondeck/ui'

import type { ConnectionHelpState } from '../lib/remoteAppUtils'

type RemoteConnectionHelpCardProps = {
  help: ConnectionHelpState
  debugRows: ReadonlyArray<readonly [string, string]>
  onReset: () => void
  variant?: 'pairing' | 'connected'
}

export function RemoteConnectionHelpCard({
  help,
  debugRows,
  onReset,
  variant = 'connected',
}: RemoteConnectionHelpCardProps) {
  const toneClass =
    help.tone === 'danger'
      ? variant === 'pairing'
        ? 'border-danger/25 bg-danger-muted/70'
        : 'border-danger/25 bg-danger-muted/60'
      : variant === 'pairing'
        ? 'border-warning/25 bg-warning-muted/70'
        : 'border-warning/25 bg-warning-muted/60'

  const panelBodyClass =
    variant === 'pairing'
      ? 'space-y-2 rounded-[var(--fd-radius-lg)] bg-surface-1 px-3 py-3 text-[length:var(--fd-text-xs)]'
      : 'grid gap-2 rounded-[var(--fd-radius-lg)] bg-surface-0/60 px-3 py-3 text-[length:var(--fd-text-xs)] md:grid-cols-2'

  return (
    <div className={`rounded-[var(--fd-radius-xl)] border px-4 py-4 ${toneClass}`}>
      <div className={variant === 'pairing' ? 'space-y-2' : 'flex flex-col gap-3 md:flex-row md:items-start md:justify-between'}>
        <div className="space-y-1.5">
          <p className="text-[length:var(--fd-text-sm)] font-semibold text-fg-primary">{help.title}</p>
          <p className="text-[length:var(--fd-text-sm)] text-fg-secondary">{help.description}</p>
          <div className="space-y-1 text-[length:var(--fd-text-xs)] text-fg-secondary">
            {help.steps.map((step) => (
              <p key={step}>{step}</p>
            ))}
          </div>
        </div>

        <div className={variant === 'pairing' ? 'flex flex-wrap gap-2 pt-1' : 'flex shrink-0 flex-wrap gap-2'}>
          <Button type="button" variant="outline" size="sm" onClick={onReset}>
            Reset saved browser connection
          </Button>
        </div>
      </div>

      <Panel collapsible defaultOpen={false} className="mt-4 border-0">
        <PanelHeader collapsible className="px-0 pb-2 pt-0 text-[length:var(--fd-text-xs)]">
          {variant === 'pairing' ? 'Local debug details' : 'Connection debug details'}
        </PanelHeader>
        <PanelContent collapsible className="px-0 pb-0">
          <div className={panelBodyClass}>
            {debugRows.map(([label, value]) => (
              <div key={label} className="flex items-center justify-between gap-3">
                <span className="text-fg-muted">{label}</span>
                <span className="text-right font-mono text-fg-secondary">{value}</span>
              </div>
            ))}
            {variant === 'pairing' ? (
              <p className="pt-1 text-fg-faint">
                Local-only diagnostics. Do not share active pairing codes or tokens in screenshots.
              </p>
            ) : null}
          </div>
        </PanelContent>
      </Panel>
    </div>
  )
}

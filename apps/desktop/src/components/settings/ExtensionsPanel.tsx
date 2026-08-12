import { useState } from 'react'

import type { ExtensionSnapshot } from '@falcondeck/client-core'
import { ActivityDiamond, Badge, Button } from '@falcondeck/ui'

export function ExtensionsPanel({
  extensions,
  onSetEnabled,
}: {
  extensions: ExtensionSnapshot
  onSetEnabled: (extensionId: string, enabled: boolean) => Promise<void>
}) {
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const update = async (extensionId: string, enabled: boolean) => {
    setPendingId(extensionId)
    setError(null)
    try {
      await onSetEnabled(extensionId, enabled)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to update extension')
    } finally {
      setPendingId(null)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[length:var(--fd-text-2xl)] font-semibold text-fg-primary">Extensions</h1>
        <p className="mt-2 text-[length:var(--fd-text-sm)] text-fg-muted">
          Extensions run behind the local daemon and stay synchronized across your clients.
        </p>
      </div>
      {error ? <p role="alert" className="text-[length:var(--fd-text-sm)] text-danger">{error}</p> : null}
      <div className="space-y-3">
        {extensions.catalog.map(extension => (
          <section key={extension.id} className="rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-2 p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-medium text-fg-primary">{extension.name}</h2>
                  {extension.bundled ? <Badge>Official</Badge> : null}
                  <Badge variant={extension.status === 'error' ? 'danger' : extension.enabled ? 'success' : 'default'}>
                    {extension.status}
                  </Badge>
                </div>
                <p className="mt-1 text-[length:var(--fd-text-xs)] text-fg-muted">
                  {extension.id} · v{extension.version} · {extension.source}
                </p>
                {extension.permissions.length > 0 ? (
                  <p className="mt-2 text-[length:var(--fd-text-xs)] text-fg-secondary">
                    Permissions: {extension.permissions.join(', ')}
                  </p>
                ) : null}
                {extension.last_error ? <p className="mt-2 text-[length:var(--fd-text-xs)] text-danger">{extension.last_error}</p> : null}
              </div>
              <Button
                type="button"
                size="sm"
                variant="secondary"
                disabled={pendingId !== null}
                onClick={() => void update(extension.id, !extension.enabled)}
              >
                {pendingId === extension.id ? <ActivityDiamond size="sm" /> : extension.enabled ? 'Disable' : 'Enable'}
              </Button>
            </div>
          </section>
        ))}
        {extensions.catalog.length === 0 ? (
          <p className="rounded-[var(--fd-radius-lg)] border border-border-subtle p-4 text-[length:var(--fd-text-sm)] text-fg-muted">
            No extensions are installed.
          </p>
        ) : null}
      </div>
    </div>
  )
}

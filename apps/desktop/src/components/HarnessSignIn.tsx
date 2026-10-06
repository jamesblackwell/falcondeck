import { useState } from 'react'
import type { HarnessSummary } from '@falcondeck/client-core'
import { Button } from '@falcondeck/ui'
import { harnessSignInCommand } from './harness-install'

/** Use the probed path so a terminal's PATH cannot select another install. */
export function HarnessSignIn({ harness, hostLabel, busy, onCheck }: {
  harness: HarnessSummary
  hostLabel: string
  busy: boolean
  onCheck: () => void
}) {
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const command = harnessSignInCommand(harness)
  if (!command || harness.auth_verdict === 'authenticated' || harness.account_status) return null

  return (
    <div className="mt-3 space-y-2 rounded-[var(--fd-radius-md)] bg-surface-2 p-3">
      <p className="text-sm text-fg-secondary">
        Sign in to {harness.label}: open Terminal on {hostLabel}, run this command and follow the browser prompts. Then check sign-in here.
      </p>
      <code className="block break-all text-xs text-fg-primary">{command}</code>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => {
          void (async () => {
            try {
              await navigator.clipboard.writeText(command)
              setCopied(command)
              setError(null)
            } catch {
              setError('Could not copy. Select and copy the command above.')
            }
          })()
        }}>
          {copied === command ? 'Copied' : 'Copy sign-in command'}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCheck}>Check sign-in</Button>
      </div>
      {error ? <p role="alert" className="text-xs text-danger">{error}</p> : null}
    </div>
  )
}

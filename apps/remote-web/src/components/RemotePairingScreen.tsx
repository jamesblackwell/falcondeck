import { useId, useState } from 'react'

import { ActivityDiamond, Button, Input } from '@falcondeck/ui'

import { ChevronDown, Lock, Smartphone } from 'lucide-react'

import type { ConnectionHelpState } from '../lib/remoteAppUtils'
import { RemoteConnectionHelpCard } from './RemoteConnectionHelpCard'

type RemotePairingScreenProps = {
  relayUrl: string
  pairingCode: string
  isConnecting: boolean
  connectionHelp: ConnectionHelpState | null
  connectionDebugRows: ReadonlyArray<readonly [string, string]>
  onRelayUrlChange: (value: string) => void
  onPairingCodeChange: (value: string) => void
  onConnect: () => void
  onResetSavedConnection: () => void
}

export function RemotePairingScreen({
  relayUrl,
  pairingCode,
  isConnecting,
  connectionHelp,
  connectionDebugRows,
  onRelayUrlChange,
  onPairingCodeChange,
  onConnect,
  onResetSavedConnection,
}: RemotePairingScreenProps) {
  const relayFieldId = useId()
  const codeFieldId = useId()
  // The relay only ever needs changing for a self-hosted deployment, and a
  // wrong value here is the hardest pairing failure to diagnose. Keep it out
  // of the way of the one field a first-time user actually fills in.
  const [showRelayField, setShowRelayField] = useState(false)
  const canSubmit = Boolean(relayUrl.trim() && pairingCode.trim()) && !isConnecting

  return (
    <div className="fd-safe-area-padded flex h-full min-h-0 flex-col items-center justify-center overflow-y-auto bg-surface-0">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-surface-2">
            <Smartphone aria-hidden="true" className="h-7 w-7 text-fg-tertiary" />
          </div>
          <h1 className="text-[length:var(--fd-text-xl)] font-semibold text-fg-primary">
            FalconDeck Remote
          </h1>
          <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-tertiary">
            Enter the pairing code shown by FalconDeck on your desktop.
          </p>
        </div>

        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (!canSubmit) return
            onConnect()
          }}
        >
          <div className="space-y-1.5">
            <label
              htmlFor={codeFieldId}
              className="block text-[length:var(--fd-text-xs)] font-medium uppercase tracking-[0.16em] text-fg-muted"
            >
              Pairing code
            </label>
            <Input
              id={codeFieldId}
              value={pairingCode}
              onChange={(event) => onPairingCodeChange(event.target.value.toUpperCase())}
              placeholder="ABCD-1234"
              autoComplete="one-time-code"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              className="text-center font-mono tracking-widest"
            />
          </div>

          <div className="space-y-1.5">
            <button
              type="button"
              onClick={() => setShowRelayField((value) => !value)}
              aria-expanded={showRelayField}
              aria-controls={relayFieldId}
              className="fd-focus flex items-center gap-1 rounded-[var(--fd-radius-sm)] text-[length:var(--fd-text-xs)] text-fg-muted transition-colors hover:text-fg-secondary"
            >
              <ChevronDown
                aria-hidden="true"
                className={`h-3 w-3 transition-transform ${showRelayField ? '' : '-rotate-90'}`}
              />
              Relay server
            </button>
            <div id={relayFieldId}>
              {showRelayField ? (
                <Input
                  value={relayUrl}
                  onChange={(event) => onRelayUrlChange(event.target.value)}
                  placeholder="https://connect.falcondeck.com"
                  aria-label="Relay server URL"
                  inputMode="url"
                  autoComplete="url"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                />
              ) : null}
            </div>
          </div>

          <Button type="submit" disabled={!canSubmit} className="w-full">
            {isConnecting ? (
              <>
                <ActivityDiamond size="md" tone="current" />
                Connecting...
              </>
            ) : (
              'Connect'
            )}
          </Button>
        </form>

        {connectionHelp ? (
          <RemoteConnectionHelpCard
            help={connectionHelp}
            debugRows={connectionDebugRows}
            onReset={onResetSavedConnection}
            variant="pairing"
          />
        ) : null}

        <div className="flex items-center justify-center gap-2 text-[length:var(--fd-text-xs)] text-fg-muted">
          <Lock aria-hidden="true" className="h-3 w-3" />
          End-to-end encrypted
        </div>
      </div>
    </div>
  )
}

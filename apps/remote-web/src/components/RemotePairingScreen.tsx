import { Button, Input } from '@falcondeck/ui'

import { Lock, Smartphone } from 'lucide-react'

import type { ConnectionHelpState } from '../lib/remoteAppUtils'
import { RemoteConnectionHelpCard } from './RemoteConnectionHelpCard'

type RemotePairingScreenProps = {
  relayUrl: string
  pairingCode: string
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
  connectionHelp,
  connectionDebugRows,
  onRelayUrlChange,
  onPairingCodeChange,
  onConnect,
  onResetSavedConnection,
}: RemotePairingScreenProps) {
  return (
    <div className="flex h-[100dvh] flex-col items-center justify-center bg-surface-0 p-6">
      <div className="w-full max-w-md space-y-6">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-surface-2">
            <Smartphone className="h-7 w-7 text-fg-tertiary" />
          </div>
          <h1 className="text-[length:var(--fd-text-xl)] font-semibold text-fg-primary">
            FalconDeck Remote
          </h1>
          <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-tertiary">
            Connect to your desktop session
          </p>
        </div>

        <div className="space-y-3">
          <Input
            value={relayUrl}
            onChange={(event) => onRelayUrlChange(event.target.value)}
            placeholder="Relay URL"
          />
          <Input
            value={pairingCode}
            onChange={(event) => onPairingCodeChange(event.target.value.toUpperCase())}
            placeholder="Pairing code"
            className="text-center font-mono tracking-widest"
          />
          <Button
            type="button"
            disabled={!relayUrl.trim() || !pairingCode.trim()}
            onClick={onConnect}
            className="w-full"
          >
            Connect
          </Button>
        </div>

        {connectionHelp ? (
          <RemoteConnectionHelpCard
            help={connectionHelp}
            debugRows={connectionDebugRows}
            onReset={onResetSavedConnection}
            variant="pairing"
          />
        ) : null}

        <div className="flex items-center justify-center gap-2 text-[length:var(--fd-text-xs)] text-fg-muted">
          <Lock className="h-3 w-3" />
          End-to-end encrypted
        </div>
      </div>
    </div>
  )
}

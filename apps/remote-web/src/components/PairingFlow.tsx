import { Smartphone } from 'lucide-react'

import { Button, Input, StatusIndicator } from '@falcondeck/ui'

export type PairingFlowProps = {
  relayUrl: string
  onRelayUrlChange: (url: string) => void
  pairingCode: string
  onPairingCodeChange: (code: string) => void
  onConnect: () => void
  connectionStatus: string
  isConnected: boolean
  error: string | null
}

export function PairingFlow({
  relayUrl,
  onRelayUrlChange,
  pairingCode,
  onPairingCodeChange,
  onConnect,
  connectionStatus,
  isConnected,
  error,
}: PairingFlowProps) {
  if (isConnected) {
    return (
      <div className="flex items-center gap-2 py-1">
        <StatusIndicator
          status={connectionStatus.includes('encrypted') ? 'connected' : 'active'}
          size="sm"
          pulse
        />
        <span className="text-[length:var(--fd-text-xs)] text-fg-secondary">{connectionStatus}</span>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <Input
        value={relayUrl}
        onChange={(event) => onRelayUrlChange(event.target.value)}
        placeholder="Relay URL"
      />
      <Input
        value={pairingCode}
        onChange={(event) => onPairingCodeChange(event.target.value.toUpperCase())}
        placeholder="Pairing code"
      />
      <Button
        type="button"
        size="sm"
        disabled={!relayUrl.trim() || !pairingCode.trim()}
        onClick={onConnect}
        className="w-full"
      >
        <Smartphone className="h-3.5 w-3.5" />
        Connect Remote
      </Button>
      <p className="text-[length:var(--fd-text-2xs)] uppercase tracking-[0.08em] text-accent">
        E2E encrypted relay
      </p>
      {error ? <p className="text-[length:var(--fd-text-xs)] text-danger">{error}</p> : null}
    </div>
  )
}

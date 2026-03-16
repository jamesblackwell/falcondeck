import {
  AlertTriangle,
  ChevronDown,
  LoaderCircle,
  RadioTower,
  Smartphone,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import * as Popover from '@radix-ui/react-popover'

import type { RemoteStatusResponse } from '@falcondeck/client-core'
import { Badge, Button, CopyButton, Input, StatusIndicator } from '@falcondeck/ui'

import { remoteDescription, remoteHeadline, remoteTone } from '../utils'

function PairingDetails({ link, code }: { link: string; code: string }) {
  return (
    <div className="space-y-2 rounded-[var(--fd-radius-lg)] bg-surface-2 p-3">
      <div className="flex justify-center rounded-[var(--fd-radius-lg)] bg-surface-0 p-4">
        <QRCodeSVG value={link} size={140} bgColor="transparent" fgColor="#f0f5f1" />
      </div>
      <div className="flex items-start gap-1.5">
        <p className="min-w-0 flex-1 break-all text-[length:var(--fd-text-2xs)] text-fg-muted">{link}</p>
        <CopyButton text={link} />
      </div>
      <div className="flex items-center justify-between text-[length:var(--fd-text-xs)]">
        <span className="text-fg-muted">Code</span>
        <div className="flex items-center gap-1.5">
          <span className="font-mono font-semibold text-fg-primary">{code}</span>
          <CopyButton text={code} />
        </div>
      </div>
    </div>
  )
}

export type RemotePairingPopoverProps = {
  remoteStatus: RemoteStatusResponse | null
  pairingLink: string | null
  relayUrl: string
  onRelayUrlChange: (url: string) => void
  onStartPairing: () => void
  isStartingRemote: boolean
}

export function RemotePairingPopover({
  remoteStatus,
  pairingLink,
  relayUrl,
  onRelayUrlChange,
  onStartPairing,
  isStartingRemote,
}: RemotePairingPopoverProps) {
  const isConnected = remoteStatus?.status === 'connected'

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="flex items-center gap-1.5 rounded-[var(--fd-radius-md)] px-2 py-1 text-[length:var(--fd-text-xs)] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-secondary"
        >
          {isConnected ? (
            <StatusIndicator status="connected" size="sm" />
          ) : (
            <RadioTower className="h-3.5 w-3.5" />
          )}
          <span className={isConnected ? 'text-success' : undefined}>
            {remoteHeadline(remoteStatus?.status)}
          </span>
          <ChevronDown className="h-3 w-3" />
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={8}
          className="z-50 w-[340px] rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 p-4 shadow-xl animate-in fade-in slide-in-from-top-1"
        >
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                <Smartphone className="h-4 w-4" />
                Remote Pairing
              </div>
              {remoteStatus ? (
                <Badge variant={remoteTone(remoteStatus.status)} dot>
                  {remoteStatus.status}
                </Badge>
              ) : null}
            </div>

            <Input
              value={relayUrl}
              onChange={(event) => onRelayUrlChange(event.target.value)}
              placeholder="Relay URL"
            />

            <Button
              type="button"
              size="sm"
              onClick={onStartPairing}
              disabled={isStartingRemote}
              className="w-full"
            >
              {isStartingRemote ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Smartphone className="h-3.5 w-3.5" />
              )}
              Start Pairing
            </Button>

            <div className="rounded-[var(--fd-radius-md)] bg-surface-2 px-3 py-2.5">
              <p className="text-[length:var(--fd-text-xs)] font-medium text-fg-secondary">
                {remoteHeadline(remoteStatus?.status)}
              </p>
              <p className="mt-1 text-[length:var(--fd-text-xs)] text-fg-muted">
                {remoteDescription(remoteStatus)}
              </p>
              <p className="mt-2 text-[length:var(--fd-text-2xs)] uppercase tracking-[0.08em] text-accent">
                E2E encrypted relay
              </p>
            </div>

            {pairingLink ? (
              <PairingDetails link={pairingLink} code={remoteStatus?.pairing?.pairing_code ?? ''} />
            ) : null}

            {remoteStatus?.last_error ? (
              <div className="rounded-[var(--fd-radius-md)] border border-danger/20 bg-danger-muted px-3 py-2.5">
                <div className="flex items-center gap-2 text-[length:var(--fd-text-xs)] font-medium text-danger">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  Remote error
                </div>
                <p className="mt-1 text-[length:var(--fd-text-xs)] text-fg-secondary">
                  {remoteStatus.last_error}
                </p>
              </div>
            ) : null}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

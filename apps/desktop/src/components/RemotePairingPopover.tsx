import {
  AlertTriangle,
  ChevronDown,
  Copy,
  LoaderCircle,
  Lock,
  Monitor,
  RadioTower,
  RefreshCw,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import * as Popover from '@radix-ui/react-popover'

import type { RemoteStatusResponse } from '@falcondeck/client-core'
import { Button, CopyButton, StatusIndicator, useToast } from '@falcondeck/ui'

import { openExternalUrl } from '../api'

/* ------------------------------------------------------------------ */
/*  Pairing QR card — shown when a pairing session is active          */
/* ------------------------------------------------------------------ */

function PairingCard({ link, code }: { link: string; code: string }) {
  const { toast } = useToast()

  async function handleOpenLink() {
    try {
      await openExternalUrl(link)
    } catch (error) {
      toast({
        variant: 'danger',
        title: 'Failed to open link',
        description:
          error instanceof Error
            ? error.message
            : 'FalconDeck could not hand this link off to your browser.',
      })
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-center text-[length:var(--fd-text-sm)] text-fg-secondary">
        Scan this QR code with the FalconDeck mobile app, or copy a secure link to connect another
        device.
      </p>

      <div className="flex justify-center rounded-[var(--fd-radius-lg)] bg-surface-0 p-5">
        <QRCodeSVG value={link} size={160} bgColor="transparent" fgColor="#f0f5f1" />
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <CopyButton
          text={link}
          variant="labeled"
          label="Copy Link"
          copiedLabel="Link Copied"
          className="h-9 justify-center rounded-[var(--fd-radius-lg)] bg-accent px-3 text-surface-0 hover:bg-accent-strong hover:text-surface-0"
        />
        <button
          type="button"
          onClick={() => void handleOpenLink()}
          className="inline-flex h-9 items-center justify-center gap-2 rounded-[var(--fd-radius-lg)] bg-surface-3 px-3 text-[length:var(--fd-text-sm)] font-medium text-fg-primary transition-colors hover:bg-surface-4"
        >
          <Copy className="h-3.5 w-3.5" />
          Open link
        </button>
      </div>

      <div className="rounded-[var(--fd-radius-md)] border border-border-subtle bg-surface-2 px-3 py-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[length:var(--fd-text-xs)] font-medium text-fg-secondary">
              Pairing code
            </p>
            <p className="mt-0.5 text-[length:var(--fd-text-2xs)] text-fg-muted">
              Use this only if you need to type the code manually.
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[length:var(--fd-text-sm)] font-semibold tracking-[0.2em] text-fg-primary">
              {code}
            </span>
            <CopyButton text={code} />
          </div>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Status label helper                                               */
/* ------------------------------------------------------------------ */

function statusLabel(status: RemoteStatusResponse['status'] | undefined) {
  switch (status) {
    case 'connected':
      return 'Connected'
    case 'device_trusted':
      return 'Paired'
    case 'connecting':
      return 'Connecting'
    case 'pairing_pending':
      return 'Waiting'
    case 'degraded':
      return 'Degraded'
    case 'offline':
      return 'Offline'
    case 'revoked':
      return 'Revoked'
    case 'error':
      return 'Error'
    default:
      return 'Inactive'
  }
}

/* ------------------------------------------------------------------ */
/*  Popover                                                           */
/* ------------------------------------------------------------------ */

export type RemotePairingPopoverProps = {
  remoteStatus: RemoteStatusResponse | null
  pairingLink: string | null
  onStartPairing: () => void
  onRefreshStatus: () => void
  isStartingRemote: boolean
}

export function RemotePairingPopover({
  remoteStatus,
  pairingLink,
  onStartPairing,
  onRefreshStatus: _onRefreshStatus,
  isStartingRemote,
}: RemotePairingPopoverProps) {
  const status = remoteStatus?.status
  const isConnected = status === 'connected'
  const isPairing = status === 'pairing_pending'
  const isActive = isConnected || status === 'device_trusted' || status === 'connecting'
  const hasPendingPairing = !!pairingLink
  const needsFreshPairing = !status || status === 'inactive' || status === 'revoked' || status === 'error' || status === 'offline'
  const activeDevices = remoteStatus?.trusted_devices?.filter((d) => d.status === 'active') ?? []

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
            {statusLabel(status)}
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
                <RadioTower className="h-4 w-4" />
                Remote Pairing
              </div>
              <span className="text-[length:var(--fd-text-2xs)] uppercase tracking-[0.18em] text-fg-faint">
                End-to-end encrypted
              </span>
            </div>

            {needsFreshPairing && !isPairing ? (
              <>
                <p className="text-[length:var(--fd-text-sm)] text-fg-muted">
                  Connect another device to use FalconDeck remotely.
                </p>
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
                    <Monitor className="h-3.5 w-3.5" />
                  )}
                  Start Pairing
                </Button>
              </>
            ) : null}

            {hasPendingPairing ? (
              <PairingCard link={pairingLink} code={remoteStatus?.pairing?.pairing_code ?? ''} />
            ) : null}

            {isActive ? (
              <div className="rounded-[var(--fd-radius-md)] bg-surface-2 px-3 py-2.5">
                {status === 'connecting' ? (
                  <div className="flex items-center gap-2 text-[length:var(--fd-text-sm)] text-fg-secondary">
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin text-accent" />
                    Reconnecting to relay…
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-[length:var(--fd-text-xs)] font-medium text-fg-muted">
                      {activeDevices.length} {activeDevices.length === 1 ? 'device' : 'devices'} connected
                    </p>
                    {activeDevices.map((d) => (
                      <div key={d.device_id} className="flex items-center gap-2">
                        <StatusIndicator status="connected" size="sm" />
                        <span className="text-[length:var(--fd-text-sm)] text-fg-primary">
                          {d.label ?? 'Unknown device'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null}

            {(status === 'degraded' || status === 'offline') ? (
              <div className="flex items-center gap-2 rounded-[var(--fd-radius-md)] bg-warning-muted px-3 py-2.5 text-[length:var(--fd-text-sm)] text-warning">
                <RefreshCw className="h-3.5 w-3.5" />
                {status === 'degraded'
                  ? 'Connection dropped — retrying…'
                  : 'Relay unreachable — retrying…'}
              </div>
            ) : null}

            {(isActive || isPairing) ? (
              <button
                type="button"
                onClick={onStartPairing}
                disabled={isStartingRemote}
                className="flex w-full items-center justify-center gap-1.5 rounded-[var(--fd-radius-md)] py-1.5 text-[length:var(--fd-text-xs)] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-secondary"
              >
                {isStartingRemote ? (
                  <LoaderCircle className="h-3 w-3 animate-spin" />
                ) : (
                  <RefreshCw className="h-3 w-3" />
                )}
                {hasPendingPairing ? 'New pairing code' : 'Pair another device'}
              </button>
            ) : null}

            {remoteStatus?.last_error ? (
              <div className="rounded-[var(--fd-radius-md)] border border-danger/20 bg-danger-muted px-3 py-2.5">
                <div className="flex items-center gap-2 text-[length:var(--fd-text-xs)] font-medium text-danger">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {remoteStatus.last_error}
                </div>
              </div>
            ) : null}

            <div className="flex items-center gap-1.5 pt-1 text-[length:var(--fd-text-2xs)] text-fg-faint">
              <Lock className="h-3 w-3" />
              Share pairing links and codes only with your own devices.
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

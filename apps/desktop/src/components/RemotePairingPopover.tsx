import {
  AlertTriangle,
  ChevronDown,
  LoaderCircle,
  Lock,
  Monitor,
  RadioTower,
  RefreshCw,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import * as Popover from '@radix-ui/react-popover'

import type { RemoteStatusResponse } from '@falcondeck/client-core'
import { Button, CopyButton, StatusIndicator } from '@falcondeck/ui'

/* ------------------------------------------------------------------ */
/*  Pairing QR card — shown when a pairing session is active          */
/* ------------------------------------------------------------------ */

function PairingCard({ link, code }: { link: string; code: string }) {
  return (
    <div className="space-y-3">
      <p className="text-center text-[length:var(--fd-text-sm)] text-fg-secondary">
        Scan or open the link to connect
      </p>

      <div className="flex justify-center rounded-[var(--fd-radius-lg)] bg-surface-0 p-5">
        <QRCodeSVG value={link} size={160} bgColor="transparent" fgColor="#f0f5f1" />
      </div>

      <div className="flex items-center justify-between rounded-[var(--fd-radius-md)] bg-surface-2 px-3 py-2">
        <span className="text-[length:var(--fd-text-xs)] text-fg-muted">Pairing code</span>
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[length:var(--fd-text-sm)] font-semibold text-fg-primary">
            {code}
          </span>
          <CopyButton text={code} />
        </div>
      </div>

      <div className="flex items-center gap-1.5">
        <a
          href={link}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 flex-1 truncate text-[length:var(--fd-text-2xs)] text-fg-muted transition-colors hover:text-accent"
        >
          {link}
        </a>
        <CopyButton text={link} />
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
  isStartingRemote: boolean
}

export function RemotePairingPopover({
  remoteStatus,
  pairingLink,
  onStartPairing,
  isStartingRemote,
}: RemotePairingPopoverProps) {
  const status = remoteStatus?.status
  const isConnected = status === 'connected'
  const isPairing = status === 'pairing_pending'
  const isActive = isConnected || status === 'device_trusted' || status === 'connecting'
  const hasPendingPairing = !!pairingLink
  const needsFreshPairing = !status || status === 'revoked' || status === 'error'
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
            {/* Header */}
            <div className="flex items-center gap-2 text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
              <RadioTower className="h-4 w-4" />
              Remote Pairing
            </div>

            {/* ── Inactive / revoked / error → prompt to start ── */}
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

            {/* ── Active pairing session → show QR code ── */}
            {hasPendingPairing ? (
              <PairingCard link={pairingLink} code={remoteStatus?.pairing?.pairing_code ?? ''} />
            ) : null}

            {/* ── Connected / trusted / connecting → show status ── */}
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

            {/* ── Degraded / offline → show retry info ── */}
            {(status === 'degraded' || status === 'offline') ? (
              <div className="flex items-center gap-2 rounded-[var(--fd-radius-md)] bg-warning-muted px-3 py-2.5 text-[length:var(--fd-text-sm)] text-warning">
                <RefreshCw className="h-3.5 w-3.5" />
                {status === 'degraded'
                  ? 'Connection dropped — retrying…'
                  : 'Relay unreachable — retrying…'}
              </div>
            ) : null}

            {/* ── Pair another device (when already active or pairing) ── */}
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
                {hasPendingPairing ? 'Generate new code' : 'Pair another device'}
              </button>
            ) : null}

            {/* ── Error details ── */}
            {remoteStatus?.last_error ? (
              <div className="rounded-[var(--fd-radius-md)] border border-danger/20 bg-danger-muted px-3 py-2.5">
                <div className="flex items-center gap-2 text-[length:var(--fd-text-xs)] font-medium text-danger">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {remoteStatus.last_error}
                </div>
              </div>
            ) : null}

            {/* ── E2E badge ── */}
            <div className="flex items-center gap-1.5 pt-1 text-[length:var(--fd-text-2xs)] text-fg-faint">
              <Lock className="h-3 w-3" />
              End-to-end encrypted
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

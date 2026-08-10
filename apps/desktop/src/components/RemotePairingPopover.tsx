import {
  AlertTriangle,
  ChevronDown,
  Copy,
  LoaderCircle,
  Lock,
  Monitor,
  RadioTower,
  RefreshCw,
  TimerOff,
  Trash2,
} from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import * as Popover from '@radix-ui/react-popover'

import type { RemoteStatusResponse, TrustedDevice } from '@falcondeck/client-core'
import { Button, CopyButton, StatusIndicator, useToast } from '@falcondeck/ui'

import { openExternalUrl } from '../api'
import { formatCountdown, useMillisUntil } from '../pairing-expiry'
import { formatRelative } from './settings/settings-utils'

/* ------------------------------------------------------------------ */
/*  Pairing QR card — shown when a pairing session is active          */
/* ------------------------------------------------------------------ */

function PairingCard({
  link,
  code,
  remainingMs,
}: {
  link: string
  code: string
  remainingMs: number | null
}) {
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
        <QRCodeSVG value={link} size={160} bgColor="transparent" fgColor="var(--fd-fg-0)" />
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
          className="fd-focus inline-flex h-9 items-center justify-center gap-2 rounded-[var(--fd-radius-lg)] bg-surface-3 px-3 text-[length:var(--fd-text-sm)] font-medium text-fg-primary transition-colors hover:bg-surface-4"
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

      {remainingMs !== null ? (
        <p className="text-center text-[length:var(--fd-text-2xs)] text-fg-muted">
          Expires in {formatCountdown(remainingMs)} · connects one device
        </p>
      ) : null}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/*  Expired pairing code                                              */
/* ------------------------------------------------------------------ */

function ExpiredPairingCard({
  onStartPairing,
  isStartingRemote,
  remoteControlsDisabled,
}: {
  onStartPairing: () => void
  isStartingRemote: boolean
  remoteControlsDisabled: boolean
}) {
  return (
    <div className="space-y-3">
      <div className="rounded-[var(--fd-radius-md)] border border-warning/25 bg-warning-muted px-3 py-2.5">
        <div className="flex items-center gap-2 text-[length:var(--fd-text-sm)] font-medium text-warning">
          <TimerOff className="h-3.5 w-3.5" />
          This pairing code expired
        </div>
        <p className="mt-1.5 text-[length:var(--fd-text-xs)] text-fg-secondary">
          Codes are short-lived and each one connects a single device. Generate a fresh code to add
          another — devices you have already paired stay connected.
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        onClick={onStartPairing}
        disabled={isStartingRemote || remoteControlsDisabled}
        className="w-full"
      >
        {isStartingRemote ? (
          <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <RefreshCw className="h-3.5 w-3.5" />
        )}
        Generate new code
      </Button>
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
  remoteControlsDisabled: boolean
  remoteControlsUnavailableReason: string | null
  onRevokeDevice?: (device: TrustedDevice) => void
  revokingDeviceId?: string | null
}

export function RemotePairingPopover({
  remoteStatus,
  pairingLink,
  onStartPairing,
  isStartingRemote,
  remoteControlsDisabled,
  remoteControlsUnavailableReason,
  onRevokeDevice,
  revokingDeviceId,
}: RemotePairingPopoverProps) {
  const status = remoteStatus?.status
  const isConnected = status === 'connected'
  const isPairing = status === 'pairing_pending'
  const isActive = isConnected || status === 'device_trusted' || status === 'connecting'
  const remainingMs = useMillisUntil(remoteStatus?.pairing?.expires_at)
  const isPairingExpired = remainingMs !== null && remainingMs <= 0
  const hasPendingPairing = !!pairingLink
  const needsFreshPairing = !status || status === 'inactive' || status === 'revoked' || status === 'error' || status === 'offline'
  const activeDevices = remoteStatus?.trusted_devices?.filter((d) => d.status === 'active') ?? []
  const connectedCount = activeDevices.filter((d) => d.connected).length

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="fd-focus flex items-center gap-1.5 rounded-[var(--fd-radius-md)] px-2 py-1 text-[length:var(--fd-text-xs)] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-secondary"
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
              <span className="text-[length:var(--fd-text-2xs)] uppercase tracking-[0.18em] text-fg-muted">
                End-to-end encrypted
              </span>
            </div>

            {needsFreshPairing && !isPairing ? (
              <>
                <p className="text-[length:var(--fd-text-sm)] text-fg-secondary">
                  Connect another device to use FalconDeck remotely.
                </p>
                {remoteControlsDisabled && remoteControlsUnavailableReason ? (
                  <div className="rounded-[var(--fd-radius-md)] border border-warning/25 bg-warning-muted px-3 py-2 text-[length:var(--fd-text-xs)] text-warning">
                    {remoteControlsUnavailableReason}
                  </div>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  onClick={onStartPairing}
                  disabled={isStartingRemote || remoteControlsDisabled}
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

            {hasPendingPairing && isPairingExpired ? (
              <ExpiredPairingCard
                onStartPairing={onStartPairing}
                isStartingRemote={isStartingRemote}
                remoteControlsDisabled={remoteControlsDisabled}
              />
            ) : null}

            {hasPendingPairing && !isPairingExpired ? (
              <PairingCard
                link={pairingLink}
                code={remoteStatus?.pairing?.pairing_code ?? ''}
                remainingMs={remainingMs}
              />
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
                      {connectedCount} of {activeDevices.length}{' '}
                      {activeDevices.length === 1 ? 'device' : 'devices'} connected
                    </p>
                    {activeDevices.map((d) => (
                      <div key={d.device_id} className="group flex items-center gap-2">
                        <StatusIndicator status={d.connected ? 'connected' : 'disconnected'} size="sm" />
                        <span
                          className={`flex-1 truncate text-[length:var(--fd-text-sm)] ${d.connected ? 'text-fg-primary' : 'text-fg-muted'}`}
                        >
                          {d.label ?? 'Unknown device'}
                        </span>
                        {!d.connected ? (
                          <span className="shrink-0 text-[length:var(--fd-text-2xs)] text-fg-faint">
                            {formatRelative(d.last_seen_at)}
                          </span>
                        ) : null}
                        {onRevokeDevice ? (
                          <button
                            type="button"
                            title="Remove device"
                            aria-label={`Remove ${d.label ?? 'device'}`}
                            className="fd-focus shrink-0 rounded-[var(--fd-radius-sm)] p-1 text-fg-faint opacity-0 transition-opacity hover:bg-danger-muted hover:text-danger focus-visible:opacity-100 group-hover:opacity-100"
                            onClick={() => onRevokeDevice(d)}
                            disabled={revokingDeviceId != null}
                          >
                            {revokingDeviceId === d.device_id ? (
                              <LoaderCircle className="h-3 w-3 animate-spin" />
                            ) : (
                              <Trash2 className="h-3 w-3" />
                            )}
                          </button>
                        ) : null}
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

            {(isActive || isPairing) && !isPairingExpired ? (
              <button
                type="button"
                onClick={onStartPairing}
                disabled={isStartingRemote || remoteControlsDisabled}
                className="fd-focus flex w-full items-center justify-center gap-1.5 rounded-[var(--fd-radius-md)] py-1.5 text-[length:var(--fd-text-xs)] text-fg-muted transition-colors hover:bg-surface-2 hover:text-fg-secondary"
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

            <div className="flex items-center gap-1.5 pt-1 text-[length:var(--fd-text-2xs)] text-fg-muted">
              <Lock className="h-3 w-3" />
              Share pairing links and codes only with your own devices.
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

import { useMemo } from 'react'

import type { TrustedDevice } from '@falcondeck/client-core'
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, CopyButton } from '@falcondeck/ui'

import { ExternalLink, LaptopMinimal, LoaderCircle, Radio, RefreshCw, Smartphone, Trash2 } from 'lucide-react'

import type { SettingsViewProps } from '../SettingsView'
import { formatDateTime, formatRelative, isMobileDeviceLabel, statusLabel, statusVariant } from './settings-utils'

type RemoteAccessPanelProps = Pick<
  SettingsViewProps,
  | 'remoteStatus'
  | 'pairingLink'
  | 'relayUrl'
  | 'isStartingRemote'
  | 'revokingDeviceId'
  | 'onStartPairing'
  | 'onRefreshRemoteStatus'
  | 'onRevokeDevice'
>

function TrustedDeviceRow({
  device,
  revokingDeviceId,
  isRemovingDevice,
  onRevokeDevice,
}: {
  device: TrustedDevice
  revokingDeviceId: string | null
  isRemovingDevice: boolean
  onRevokeDevice: (device: TrustedDevice) => void
}) {
  const isMobileDevice = isMobileDeviceLabel(device.label)

  return (
    <div className="flex flex-col gap-3 rounded-[var(--fd-radius-xl)] border border-border-subtle bg-surface-2 p-4 md:flex-row md:items-center md:justify-between">
      <div className="flex items-start gap-3">
        <div className="rounded-[var(--fd-radius-lg)] bg-surface-3 p-2 text-fg-secondary">
          {isMobileDevice ? <Smartphone className="h-4 w-4" /> : <LaptopMinimal className="h-4 w-4" />}
        </div>
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
              {device.label ?? 'Unnamed device'}
            </p>
            <Badge variant={statusVariant(device.status)} dot>
              {statusLabel(device.status)}
            </Badge>
          </div>
          <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
            Added {formatDateTime(device.created_at)}
          </p>
          <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
            Last seen {formatRelative(device.last_seen_at)}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <span className="truncate text-[length:var(--fd-text-2xs)] text-fg-faint">
          {device.device_id}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-danger hover:bg-danger-muted hover:text-danger"
          onClick={() => onRevokeDevice(device)}
          disabled={isRemovingDevice || device.status === 'revoked'}
        >
          {revokingDeviceId === device.device_id ? (
            <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Trash2 className="h-3.5 w-3.5" />
          )}
          Remove
        </Button>
      </div>
    </div>
  )
}

export function RemoteAccessPanel({
  remoteStatus,
  pairingLink,
  relayUrl,
  isStartingRemote,
  revokingDeviceId,
  onStartPairing,
  onRefreshRemoteStatus,
  onRevokeDevice,
}: RemoteAccessPanelProps) {
  const devices = useMemo(() => remoteStatus?.trusted_devices ?? [], [remoteStatus?.trusted_devices])
  const hasActivePairing = Boolean(remoteStatus?.pairing)
  const isRemovingDevice = revokingDeviceId !== null
  const activeDevices = useMemo(
    () => devices.filter((device) => device.status === 'active'),
    [devices],
  )

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-[length:var(--fd-text-xs)] uppercase tracking-[0.24em] text-fg-muted">
          Settings
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-[length:var(--fd-text-2xl)] font-semibold text-fg-primary">
            Remote Access
          </h1>
          <Badge variant={statusVariant(remoteStatus?.status ?? 'inactive')} dot>
            {statusLabel(remoteStatus?.status ?? 'inactive')}
          </Badge>
        </div>
        <p className="max-w-2xl text-[length:var(--fd-text-sm)] text-fg-tertiary">
          Pair devices, inspect relay health, and remove trusted devices from one place.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Pair New Device</CardTitle>
          <CardDescription>
            A pairing code is a temporary invite. Generating a new one adds another device to this
            session and does not sign out existing devices.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Button type="button" onClick={onStartPairing} disabled={isStartingRemote}>
              {isStartingRemote ? (
                <LoaderCircle className="h-4 w-4 animate-spin" />
              ) : (
                <Radio className="h-4 w-4" />
              )}
              {remoteStatus?.pairing ? 'Generate New Pairing Code' : 'Start Pairing'}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={onRefreshRemoteStatus}>
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh status
            </Button>
            <Badge variant="default" dot>
              End-to-end encrypted
            </Badge>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-[var(--fd-radius-xl)] border border-border-subtle bg-surface-2 p-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-[length:var(--fd-text-xs)] uppercase tracking-[0.18em] text-fg-muted">
                    Pairing code
                  </p>
                  <p className="mt-2 font-mono text-[length:var(--fd-text-xl)] font-semibold tracking-[0.16em] text-fg-primary">
                    {remoteStatus?.pairing?.pairing_code ?? 'No active code'}
                  </p>
                </div>
                {remoteStatus?.pairing?.pairing_code ? (
                  <CopyButton text={remoteStatus.pairing.pairing_code} />
                ) : null}
              </div>
              {hasActivePairing ? (
                <p className="mt-3 text-[length:var(--fd-text-xs)] text-fg-muted">
                  Expires {formatRelative(remoteStatus?.pairing?.expires_at ?? null)}
                </p>
              ) : (
                <p className="mt-3 text-[length:var(--fd-text-xs)] text-fg-muted">
                  Generate a code when you want to invite another device.
                </p>
              )}
            </div>

            <div className="rounded-[var(--fd-radius-xl)] border border-border-subtle bg-surface-2 p-4">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[length:var(--fd-text-xs)] uppercase tracking-[0.18em] text-fg-muted">
                    Remote link
                  </p>
                  <p className="mt-2 truncate text-[length:var(--fd-text-sm)] text-fg-secondary">
                    {pairingLink ?? 'No active link'}
                  </p>
                </div>
                {pairingLink ? <CopyButton text={pairingLink} /> : null}
              </div>
              {pairingLink ? (
                <a
                  href={pairingLink}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-3 inline-flex items-center gap-1.5 text-[length:var(--fd-text-xs)] text-accent hover:text-accent-strong"
                >
                  Open remote link
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : (
                <p className="mt-3 text-[length:var(--fd-text-xs)] text-fg-muted">
                  Generate a code to create a shareable remote link.
                </p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Trusted Devices</CardTitle>
          <CardDescription>
            Devices below can access this desktop session through the relay. Remove any device you
            no longer trust.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {devices.length === 0 ? (
            <div className="rounded-[var(--fd-radius-xl)] border border-dashed border-border-default bg-surface-2 px-4 py-5 text-[length:var(--fd-text-sm)] text-fg-muted">
              No trusted devices yet. Pair a phone, tablet, or browser to see it here.
            </div>
          ) : (
            devices.map((device) => (
              <TrustedDeviceRow
                key={device.device_id}
                device={device}
                revokingDeviceId={revokingDeviceId}
                isRemovingDevice={isRemovingDevice}
                onRevokeDevice={onRevokeDevice}
              />
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Connection Status</CardTitle>
          <CardDescription>
            Quick health check for the desktop daemon and relay session.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-[length:var(--fd-text-sm)]">
          <div className="flex items-center justify-between gap-4">
            <span className="text-fg-tertiary">Relay URL</span>
            <span className="truncate text-right text-fg-primary">{remoteStatus?.relay_url ?? relayUrl}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-fg-tertiary">Desktop relay link</span>
            <Badge variant={remoteStatus?.presence?.daemon_connected ? 'success' : 'warning'} dot>
              {remoteStatus?.presence?.daemon_connected ? 'Online' : 'Waiting'}
            </Badge>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-fg-tertiary">Trusted devices</span>
            <span className="text-fg-primary">{activeDevices.length}</span>
          </div>
          <div className="flex items-center justify-between gap-4">
            <span className="text-fg-tertiary">Last desktop seen</span>
            <span className="text-fg-primary">
              {formatRelative(remoteStatus?.presence?.last_seen_at ?? null)}
            </span>
          </div>
          {remoteStatus?.last_error ? (
            <div className="rounded-[var(--fd-radius-lg)] bg-danger-muted px-3 py-2 text-danger">
              {remoteStatus.last_error}
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  )
}

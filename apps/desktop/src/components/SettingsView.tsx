import { useMemo, useState } from 'react'

import type {
  FalconDeckPreferences,
  RemoteStatusResponse,
  ToolDetailsMode,
  TrustedDevice,
  UpdatePreferencesPayload,
  WorkspaceSummary,
} from '@falcondeck/client-core'
import { normalizePreferences } from '@falcondeck/client-core'
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CopyButton,
  cn,
} from '@falcondeck/ui'
import {
  ArrowLeft,
  ExternalLink,
  LaptopMinimal,
  LoaderCircle,
  Radio,
  RefreshCw,
  Settings,
  Smartphone,
  Trash2,
  Wifi,
} from 'lucide-react'

type SettingsSectionId = 'general' | 'remote'

type SettingsViewProps = {
  workspace?: WorkspaceSummary | null
  preferences: FalconDeckPreferences | null
  remoteStatus: RemoteStatusResponse | null
  pairingLink: string | null
  relayUrl: string
  isStartingRemote: boolean
  revokingDeviceId: string | null
  onUpdatePreferences: (payload: UpdatePreferencesPayload) => void
  onStartPairing: () => void
  onRefreshRemoteStatus: () => void
  onRevokeDevice: (device: TrustedDevice) => void
  onClose: () => void
}

type SettingsNavItem = {
  id: SettingsSectionId
  label: string
  description: string
  icon: typeof Settings
}

const SETTINGS_NAV: SettingsNavItem[] = [
  {
    id: 'general',
    label: 'General',
    description: 'Core app behavior and future defaults',
    icon: Settings,
  },
  {
    id: 'remote',
    label: 'Remote Access',
    description: 'Pairing, devices, and relay status',
    icon: Wifi,
  },
]

function statusVariant(status: RemoteStatusResponse['status'] | TrustedDevice['status']) {
  switch (status) {
    case 'connected':
    case 'device_trusted':
    case 'active':
      return 'success'
    case 'pairing_pending':
    case 'connecting':
    case 'degraded':
    case 'offline':
      return 'warning'
    case 'revoked':
      return 'danger'
    default:
      return 'default'
  }
}

function statusLabel(status: RemoteStatusResponse['status'] | TrustedDevice['status']) {
  switch (status) {
    case 'pairing_pending':
      return 'Waiting for device'
    case 'device_trusted':
      return 'Trusted'
    case 'connecting':
      return 'Connecting'
    case 'connected':
      return 'Connected'
    case 'degraded':
      return 'Reconnecting'
    case 'offline':
      return 'Offline'
    case 'revoked':
      return 'Revoked'
    case 'active':
      return 'Active'
    case 'error':
      return 'Error'
    case 'inactive':
    default:
      return 'Inactive'
  }
}

function formatDateTime(value: string | null) {
  if (!value) return 'Never'
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value))
  } catch {
    return value
  }
}

function formatRelative(value: string | null) {
  if (!value) return 'Never'
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return formatDateTime(value)

  const seconds = Math.round((timestamp - Date.now()) / 1000)
  const absSeconds = Math.abs(seconds)
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

  if (absSeconds < 60) return formatter.format(seconds, 'second')
  const minutes = Math.round(seconds / 60)
  if (Math.abs(minutes) < 60) return formatter.format(minutes, 'minute')
  const hours = Math.round(minutes / 60)
  if (Math.abs(hours) < 24) return formatter.format(hours, 'hour')
  const days = Math.round(hours / 24)
  return formatter.format(days, 'day')
}

function deviceIcon(label: string | null) {
  const normalized = label?.toLowerCase() ?? ''
  return normalized.includes('iphone') || normalized.includes('ipad') || normalized.includes('android')
    ? Smartphone
    : LaptopMinimal
}

const TOOL_DETAIL_OPTIONS: Array<{
  value: ToolDetailsMode
  label: string
  description: string
}> = [
  {
    value: 'auto',
    label: 'Auto',
    description: 'Collapse repeated read-only tool chatter, but auto-open diffs, approvals, and failures.',
  },
  {
    value: 'expanded',
    label: 'Expanded',
    description: 'Keep tool output open by default for dense debugging sessions.',
  },
  {
    value: 'compact',
    label: 'Compact',
    description: 'Prefer grouped summaries for read-only work while keeping artifacts visible.',
  },
  {
    value: 'hide_read_only_details',
    label: 'Hide read-only details',
    description: 'Show grouped summaries for read-only inspection without rendering their raw output.',
  },
]

function PreferenceToggle({
  label,
  description,
  enabled,
  onToggle,
}: {
  label: string
  description: string
  enabled: boolean
  onToggle: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(!enabled)}
      className={cn(
        'flex w-full items-start justify-between gap-4 rounded-[var(--fd-radius-lg)] border px-4 py-3 text-left transition-colors',
        enabled
          ? 'border-accent/40 bg-accent/10'
          : 'border-border-subtle bg-surface-2 hover:bg-surface-3',
      )}
    >
      <div>
        <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">{label}</p>
        <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-tertiary">{description}</p>
      </div>
      <Badge variant={enabled ? 'success' : 'default'} dot>
        {enabled ? 'On' : 'Off'}
      </Badge>
    </button>
  )
}

function GeneralSettingsPanel({
  workspace,
  preferences,
  onUpdatePreferences,
}: {
  workspace?: WorkspaceSummary | null
  preferences: FalconDeckPreferences | null
  onUpdatePreferences: (payload: UpdatePreferencesPayload) => void
}) {
  const current = normalizePreferences(preferences)

  return (
    <div className="space-y-6">
      <header className="space-y-2">
        <p className="text-[length:var(--fd-text-xs)] uppercase tracking-[0.24em] text-fg-muted">
          Settings
        </p>
        <h1 className="text-[length:var(--fd-text-2xl)] font-semibold text-fg-primary">
          General
        </h1>
        <p className="max-w-2xl text-[length:var(--fd-text-sm)] text-fg-tertiary">
          FalconDeck stores these preferences in a daemon-owned `falcondeck.json` file so desktop
          and remote surfaces stay aligned.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Conversation Density</CardTitle>
          <CardDescription>
            Choose how much raw tool detail the thread should show by default.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {TOOL_DETAIL_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onUpdatePreferences({ conversation: { tool_details_mode: option.value } })}
              className={cn(
                'rounded-[var(--fd-radius-xl)] border p-4 text-left transition-colors',
                current.conversation.tool_details_mode === option.value
                  ? 'border-accent/50 bg-accent/10'
                  : 'border-border-subtle bg-surface-2 hover:bg-surface-3',
              )}
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                  {option.label}
                </p>
                <Badge
                  variant={
                    current.conversation.tool_details_mode === option.value ? 'success' : 'default'
                  }
                >
                  {current.conversation.tool_details_mode === option.value ? 'Selected' : 'Available'}
                </Badge>
              </div>
              <p className="mt-2 text-[length:var(--fd-text-sm)] text-fg-tertiary">
                {option.description}
              </p>
            </button>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Auto-Expand Rules</CardTitle>
          <CardDescription>
            Keep risky or high-signal artifacts obvious even when read-only chatter is grouped.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <PreferenceToggle
            label="Group read-only tool bursts"
            description="Collapse consecutive file reads, searches, and similar inspection commands into a compact summary row."
            enabled={current.conversation.group_read_only_tools}
            onToggle={(next) => onUpdatePreferences({ conversation: { group_read_only_tools: next } })}
          />
          <PreferenceToggle
            label="Show expand/collapse all controls"
            description="Expose quick thread-level controls above the conversation when tool cards are present."
            enabled={current.conversation.show_expand_all_controls}
            onToggle={(next) => onUpdatePreferences({ conversation: { show_expand_all_controls: next } })}
          />
          <PreferenceToggle
            label="Auto-open approvals"
            description="Always expand approval-related artifacts so side effects stay obvious."
            enabled={current.conversation.auto_expand.approvals}
            onToggle={(next) => onUpdatePreferences({ conversation: { auto_expand: { approvals: next } } })}
          />
          <PreferenceToggle
            label="Auto-open errors"
            description="Expand errors immediately so debugging does not hide behind compact mode."
            enabled={current.conversation.auto_expand.errors}
            onToggle={(next) => onUpdatePreferences({ conversation: { auto_expand: { errors: next } } })}
          />
          <PreferenceToggle
            label="Auto-open failed tests"
            description="Keep failing test runs visible even when successful inspection bursts are collapsed."
            enabled={current.conversation.auto_expand.failed_tests}
            onToggle={(next) => onUpdatePreferences({ conversation: { auto_expand: { failed_tests: next } } })}
          />
          <PreferenceToggle
            label="Auto-open the first diff"
            description="Keep the first patch in a thread visible even when inspection noise is collapsed."
            enabled={current.conversation.auto_expand.first_diff}
            onToggle={(next) => onUpdatePreferences({ conversation: { auto_expand: { first_diff: next } } })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Agent Status</CardTitle>
          <CardDescription>
            Provider-specific readiness for Codex and Claude now lives here so the new composer toggle has real operational context behind it.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          {(workspace?.agents ?? []).map((agent) => (
            <div
              key={agent.provider}
              className="rounded-[var(--fd-radius-xl)] border border-border-subtle bg-surface-2 p-4"
            >
              <div className="flex items-center justify-between gap-3">
                <p className="text-[length:var(--fd-text-sm)] font-medium capitalize text-fg-primary">
                  {agent.provider}
                </p>
                <Badge
                  variant={
                    agent.account.status === 'ready'
                      ? 'success'
                      : agent.account.status === 'needs_auth'
                        ? 'warning'
                        : 'default'
                  }
                  dot
                >
                  {agent.account.status === 'ready'
                    ? 'Ready'
                    : agent.account.status === 'needs_auth'
                      ? 'Needs auth'
                      : 'Unknown'}
                </Badge>
              </div>
              <p className="mt-2 text-[length:var(--fd-text-sm)] text-fg-tertiary">
                {agent.account.label}
              </p>
              <p className="mt-3 text-[length:var(--fd-text-xs)] uppercase tracking-[0.18em] text-fg-muted">
                {agent.models.length} model options
              </p>
            </div>
          ))}
        </CardContent>
        {workspace?.last_error && /could not find|could not be started|failed to start/i.test(workspace.last_error) ? (
          <CardContent className="pt-0">
            <div className="rounded-[var(--fd-radius-xl)] border border-warning/20 bg-warning/10 p-4">
              <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                FalconDeck could not launch one of the local agent CLIs
              </p>
              <p className="mt-2 text-[length:var(--fd-text-sm)] text-fg-tertiary">
                FalconDeck now auto-detects `claude` and `codex` from the app PATH, common install
                locations, and your login shell. If a provider still fails to launch, relaunch the
                app after installing the CLI or set `FALCONDECK_CLAUDE_BIN` / `FALCONDECK_CODEX_BIN`
                before starting FalconDeck.
              </p>
              <p className="mt-3 rounded-[var(--fd-radius-lg)] bg-surface-1 px-3 py-2 text-[length:var(--fd-text-sm)] text-fg-secondary">
                {workspace.last_error}
              </p>
            </div>
          </CardContent>
        ) : null}
      </Card>
    </div>
  )
}

function RemoteAccessPanel({
  remoteStatus,
  pairingLink,
  relayUrl,
  isStartingRemote,
  revokingDeviceId,
  onStartPairing,
  onRefreshRemoteStatus,
  onRevokeDevice,
}: Pick<
  SettingsViewProps,
  | 'remoteStatus'
  | 'pairingLink'
  | 'relayUrl'
  | 'isStartingRemote'
  | 'revokingDeviceId'
  | 'onStartPairing'
  | 'onRefreshRemoteStatus'
  | 'onRevokeDevice'
>) {
  const devices = remoteStatus?.trusted_devices ?? []
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
            devices.map((device) => {
              const Icon = deviceIcon(device.label)
              return (
                <div
                  key={device.device_id}
                  className="flex flex-col gap-3 rounded-[var(--fd-radius-xl)] border border-border-subtle bg-surface-2 p-4 md:flex-row md:items-center md:justify-between"
                >
                  <div className="flex items-start gap-3">
                    <div className="rounded-[var(--fd-radius-lg)] bg-surface-3 p-2 text-fg-secondary">
                      <Icon className="h-4 w-4" />
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
            })
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
            <Badge
              variant={remoteStatus?.presence?.daemon_connected ? 'success' : 'warning'}
              dot
            >
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

export function SettingsView(props: SettingsViewProps) {
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('general')

  return (
    <section className="flex h-full min-h-0 bg-surface-1">
      <aside className="flex w-[280px] shrink-0 flex-col border-r border-border-subtle bg-[color-mix(in_oklab,var(--color-surface-1)_96%,black)]">
        <div className="border-b border-border-subtle px-4 pb-4 pt-11">
          <button
            type="button"
            onClick={props.onClose}
            className="flex items-center gap-2 rounded-[var(--fd-radius-md)] px-2 py-1.5 text-[length:var(--fd-text-sm)] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-primary"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to app
          </button>
        </div>

        <div className="flex-1 px-3 py-4">
          <nav className="space-y-1">
            {SETTINGS_NAV.map((item) => {
              const Icon = item.icon
              const isActive = item.id === activeSection
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveSection(item.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-[var(--fd-radius-lg)] px-3 py-2.5 text-left transition-colors',
                    isActive
                      ? 'bg-surface-3 text-fg-primary'
                      : 'text-fg-secondary hover:bg-surface-2 hover:text-fg-primary',
                  )}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-[length:var(--fd-text-sm)] font-medium">
                      {item.label}
                    </span>
                    <span className="mt-0.5 block text-[length:var(--fd-text-xs)] text-fg-muted">
                      {item.description}
                    </span>
                  </span>
                </button>
              )
            })}
          </nav>
        </div>
      </aside>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-10">
        <div className="mx-auto w-full max-w-4xl">
          {activeSection === 'general' ? (
            <GeneralSettingsPanel
              workspace={props.workspace}
              preferences={props.preferences}
              onUpdatePreferences={props.onUpdatePreferences}
            />
          ) : (
            <RemoteAccessPanel
              remoteStatus={props.remoteStatus}
              pairingLink={props.pairingLink}
              relayUrl={props.relayUrl}
              isStartingRemote={props.isStartingRemote}
              revokingDeviceId={props.revokingDeviceId}
              onStartPairing={props.onStartPairing}
              onRefreshRemoteStatus={props.onRefreshRemoteStatus}
              onRevokeDevice={props.onRevokeDevice}
            />
          )}
        </div>
      </div>
    </section>
  )
}

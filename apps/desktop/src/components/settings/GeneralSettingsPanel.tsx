import type {
  FalconDeckPreferences,
  UpdatePreferencesPayload,
  WorkspaceSummary,
} from '@falcondeck/client-core'
import { normalizePreferences } from '@falcondeck/client-core'
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, cn } from '@falcondeck/ui'

import { Download, FolderSync, LoaderCircle, RotateCcw } from 'lucide-react'

import type { AppUpdaterState } from '../../hooks/useAppUpdater'
import { PreferenceToggle } from './PreferenceToggle'
import {
  formatDateTime,
  formatRelative,
  TOOL_DETAIL_OPTIONS,
  updateBadgeVariant,
  updateStatusLabel,
} from './settings-utils'

type GeneralSettingsPanelProps = {
  workspace?: WorkspaceSummary | null
  preferences: FalconDeckPreferences | null
  updater: AppUpdaterState
  updaterProgressPercent: number | null
  onUpdatePreferences: (payload: UpdatePreferencesPayload) => void
  onCheckForUpdates: () => void
  onDownloadUpdate: () => void
  onRestartToInstallUpdate: () => void
}

export function GeneralSettingsPanel({
  workspace,
  preferences,
  updater,
  updaterProgressPercent,
  onUpdatePreferences,
  onCheckForUpdates,
  onDownloadUpdate,
  onRestartToInstallUpdate,
}: GeneralSettingsPanelProps) {
  const current = normalizePreferences(preferences)
  const isChecking = updater.status === 'checking'
  const isDownloading = updater.status === 'downloading'
  const primaryAction =
    updater.status === 'available'
      ? {
          label: 'Download update',
          icon: Download,
          onClick: onDownloadUpdate,
          disabled: false,
        }
      : updater.status === 'downloaded'
        ? {
            label: 'Restart to install',
            icon: RotateCcw,
            onClick: onRestartToInstallUpdate,
            disabled: false,
          }
        : {
            label: 'Check for updates',
            icon: isChecking ? LoaderCircle : FolderSync,
            onClick: onCheckForUpdates,
            disabled: isChecking || isDownloading,
          }

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
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <CardTitle>App Updates</CardTitle>
              <CardDescription>
                FalconDeck checks GitHub Releases on launch and every 4 hours while the app stays open.
              </CardDescription>
            </div>
            <Badge variant={updateBadgeVariant(updater.status)} dot>
              {updateStatusLabel(updater.status)}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-[var(--fd-radius-xl)] border border-border-subtle bg-surface-2 p-4">
              <p className="text-[length:var(--fd-text-xs)] uppercase tracking-[0.18em] text-fg-muted">
                Current version
              </p>
              <p className="mt-2 text-[length:var(--fd-text-lg)] font-medium text-fg-primary">
                {updater.currentVersion ?? 'Unknown'}
              </p>
              <p className="mt-2 text-[length:var(--fd-text-xs)] text-fg-muted">Channel: stable</p>
            </div>
            <div className="rounded-[var(--fd-radius-xl)] border border-border-subtle bg-surface-2 p-4">
              <p className="text-[length:var(--fd-text-xs)] uppercase tracking-[0.18em] text-fg-muted">
                Last checked
              </p>
              <p className="mt-2 text-[length:var(--fd-text-lg)] font-medium text-fg-primary">
                {formatRelative(updater.lastCheckedAt)}
              </p>
              <p className="mt-2 text-[length:var(--fd-text-xs)] text-fg-muted">
                {updater.lastCheckedAt ? formatDateTime(updater.lastCheckedAt) : 'No checks yet'}
              </p>
            </div>
          </div>

          <div className="rounded-[var(--fd-radius-xl)] border border-border-subtle bg-surface-2 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                  {updater.availableVersion
                    ? `FalconDeck ${updater.availableVersion} is ready`
                    : updater.status === 'upToDate'
                      ? 'You are on the latest stable release'
                      : 'Updater status'}
                </p>
                <p className="mt-1 text-[length:var(--fd-text-sm)] text-fg-tertiary">
                  {updater.status === 'downloaded'
                    ? 'The update is downloaded. Restart FalconDeck to install it cleanly with the embedded daemon.'
                    : updater.status === 'downloading'
                      ? `Downloading the release bundle${updaterProgressPercent !== null ? ` (${updaterProgressPercent}%)` : ''}.`
                      : updater.status === 'available'
                        ? 'Download the signed release and install it on restart.'
                        : updater.errorMessage ?? 'Background checks stay quiet unless a new release is available.'}
                </p>
              </div>
              <Button type="button" onClick={primaryAction.onClick} disabled={primaryAction.disabled}>
                <primaryAction.icon className={cn('h-4 w-4', (isChecking || isDownloading) && 'animate-spin')} />
                {primaryAction.label}
              </Button>
            </div>
            {isDownloading ? (
              <div className="mt-4 space-y-2">
                <div className="h-2 overflow-hidden rounded-full bg-surface-3">
                  <div
                    className="h-full rounded-full bg-accent transition-[width]"
                    style={{ width: `${updaterProgressPercent ?? 8}%` }}
                  />
                </div>
                <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
                  {updater.totalBytes
                    ? `${Math.round(updater.downloadedBytes / 1024 / 1024)}MB of ${Math.round(updater.totalBytes / 1024 / 1024)}MB`
                    : 'Calculating download size…'}
                </p>
              </div>
            ) : null}
            {updater.notes ? (
              <div className="mt-4 rounded-[var(--fd-radius-lg)] bg-surface-1 px-3 py-3">
                <p className="text-[length:var(--fd-text-xs)] uppercase tracking-[0.18em] text-fg-muted">
                  Release notes
                </p>
                <p className="mt-2 whitespace-pre-wrap text-[length:var(--fd-text-sm)] text-fg-secondary">
                  {updater.notes}
                </p>
                {updater.publishedAt ? (
                  <p className="mt-3 text-[length:var(--fd-text-xs)] text-fg-muted">
                    Published {formatDateTime(updater.publishedAt)}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </CardContent>
      </Card>

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
                  variant={current.conversation.tool_details_mode === option.value ? 'success' : 'default'}
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
              <p className="mt-2 text-[length:var(--fd-text-sm)] text-fg-tertiary">{agent.account.label}</p>
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

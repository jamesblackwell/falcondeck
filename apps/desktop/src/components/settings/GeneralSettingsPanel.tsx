import type { FalconDeckPreferences, UpdatePreferencesPayload } from '@falcondeck/client-core'
import { normalizePreferences } from '@falcondeck/client-core'
import {
  ActivityDiamond,
  Badge,
  Button,
  SettingList,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
  SwitchRow,
} from '@falcondeck/ui'

import { Download, FolderSync, RotateCcw } from 'lucide-react'

import type { AppUpdaterState } from '../../hooks/useAppUpdater'
import {
  formatDateTime,
  formatRelative,
  updateBadgeVariant,
  updateStatusLabel,
} from './settings-utils'

type GeneralSettingsPanelProps = {
  preferences: FalconDeckPreferences | null
  updater: AppUpdaterState
  updaterProgressPercent: number | null
  onUpdatePreferences: (payload: UpdatePreferencesPayload) => void
  onCheckForUpdates: () => void
  onDownloadUpdate: () => void
  onRestartToInstallUpdate: () => void
  /** Settings → General rerun control: clears the device-local onboarding flag so the wizard replays on next launch. */
  onShowOnboardingAtNextLaunch: () => void
}

export function GeneralSettingsPanel({
  preferences,
  updater,
  updaterProgressPercent,
  onUpdatePreferences,
  onCheckForUpdates,
  onDownloadUpdate,
  onRestartToInstallUpdate,
  onShowOnboardingAtNextLaunch,
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
            label: 'Restart to finish update',
            icon: RotateCcw,
            onClick: onRestartToInstallUpdate,
            disabled: false,
          }
        : {
            label: 'Check for updates',
            icon: FolderSync,
            onClick: onCheckForUpdates,
            disabled: isChecking || isDownloading,
          }

  return (
    <SettingsPage>
      <SettingsPageHeader
        title="General"
        description="Startup behavior, app updates, and first-run setup."
      />

      <SettingsSection title="Startup" description="Pick up where your agents left off.">
        <SettingList>
          <SwitchRow
            title="Automatically continue stopped sessions"
            description="Continue sessions interrupted when FalconDeck closed, using their saved agent and permissions."
            checked={current.auto_resume_interrupted_sessions === true}
            onCheckedChange={(enabled) =>
              onUpdatePreferences({ auto_resume_interrupted_sessions: enabled })
            }
          />
        </SettingList>
      </SettingsSection>

      <SettingsSection
        title="Updates"
        description="FalconDeck checks GitHub Releases on launch and every 4 hours while the app stays open."
        actions={
          <Badge variant={updateBadgeVariant(updater.status)} dot>
            {updateStatusLabel(updater.status)}
          </Badge>
        }
        contentClassName="space-y-4"
      >
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
                  ? 'The signed update is installed. Restart FalconDeck to run the new version with its embedded daemon.'
                  : updater.status === 'downloading'
                    ? `Downloading the release bundle${updaterProgressPercent !== null ? ` (${updaterProgressPercent}%)` : ''}.`
                    : updater.status === 'available'
                      ? 'Download and install the signed release, then restart to use it.'
                      : (updater.errorMessage ??
                        'Background checks stay quiet unless a new release is available.')}
              </p>
            </div>
            <Button type="button" onClick={primaryAction.onClick} disabled={primaryAction.disabled}>
              {isChecking || isDownloading ? (
                <ActivityDiamond size="md" tone="current" />
              ) : (
                <primaryAction.icon className="h-4 w-4" />
              )}
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
      </SettingsSection>

      <SettingsSection
        title="First-run onboarding"
        description="Replay the welcome wizard as a new install would see it. Only the device-local onboarding flag is reset — projects, conversations, keys, and daemon state are untouched."
      >
        <Button type="button" variant="outline" onClick={onShowOnboardingAtNextLaunch}>
          Show onboarding at next launch
        </Button>
      </SettingsSection>
    </SettingsPage>
  )
}

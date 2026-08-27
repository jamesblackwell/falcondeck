import type {
  FalconDeckPreferences,
  UpdatePreferencesPayload,
  WorkspaceSummary,
} from '@falcondeck/client-core'
import { normalizePreferences } from '@falcondeck/client-core'
import {
  ActivityDiamond,
  Badge,
  Button,
  OptionCard,
  SettingList,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
  SwitchRow,
} from '@falcondeck/ui'

import { Download, FolderSync, RotateCcw } from 'lucide-react'

import type { AppUpdaterState } from '../../hooks/useAppUpdater'
import { BackgroundModelsCard } from './BackgroundModelsCard'
import {
  formatDateTime,
  formatRelative,
  THINKING_DISPLAY_OPTIONS,
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
  /** Settings → General rerun control: clears the device-local onboarding flag so the wizard replays on next launch. */
  onShowOnboardingAtNextLaunch: () => void
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
            label: 'Restart to install',
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
        description="Updates, notifications, and how conversations read. These preferences live in a daemon-owned falcondeck.json so desktop and remote surfaces stay aligned."
      />

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
                  ? 'The update is downloaded. Restart FalconDeck to install it cleanly with the embedded daemon.'
                  : updater.status === 'downloading'
                    ? `Downloading the release bundle${updaterProgressPercent !== null ? ` (${updaterProgressPercent}%)` : ''}.`
                    : updater.status === 'available'
                      ? 'Download the signed release and install it on restart.'
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
        title="Notifications"
        description="Attention signals across desktop and mobile. Stored by the daemon and synced to every paired client."
        contentClassName="pt-1"
      >
        <SettingList>
          <SwitchRow
            title="Agent attention notifications"
            description="Allow FalconDeck to notify paired devices about important agent events."
            checked={current.notifications.enabled}
            onCheckedChange={(next) => onUpdatePreferences({ notifications: { enabled: next } })}
          />
          <SwitchRow
            title="Completed turns"
            description="Notify when an agent finishes a turn while you are away from this desktop."
            checked={current.notifications.notify_on_turn_complete}
            onCheckedChange={(next) =>
              onUpdatePreferences({ notifications: { notify_on_turn_complete: next } })
            }
          />
          <SwitchRow
            title="Approvals and questions"
            description="Notify when an agent is blocked waiting for your decision or answer."
            checked={current.notifications.notify_on_input_required}
            onCheckedChange={(next) =>
              onUpdatePreferences({ notifications: { notify_on_input_required: next } })
            }
          />
          <SwitchRow
            title="Failed turns"
            description="Notify when an agent turn ends with an error that may need investigation."
            checked={current.notifications.notify_on_error}
            onCheckedChange={(next) =>
              onUpdatePreferences({ notifications: { notify_on_error: next } })
            }
          />
          <SwitchRow
            title="Suppress pushes while desktop is active"
            description="Avoid sending a phone push while this desktop window is focused; the activity lease expires automatically when it is not."
            checked={current.notifications.suppress_when_desktop_active}
            onCheckedChange={(next) =>
              onUpdatePreferences({ notifications: { suppress_when_desktop_active: next } })
            }
          />
        </SettingList>
      </SettingsSection>

      <BackgroundModelsCard
        workspace={workspace}
        preferences={current}
        onUpdatePreferences={onUpdatePreferences}
      />

      <SettingsSection
        title="Conversation density"
        description="How much raw tool detail a thread shows by default."
        contentClassName="grid gap-3 md:grid-cols-2"
      >
        {TOOL_DETAIL_OPTIONS.map((option) => (
          <OptionCard
            key={option.value}
            label={option.label}
            description={option.description}
            selected={current.conversation.tool_details_mode === option.value}
            onSelect={() =>
              onUpdatePreferences({ conversation: { tool_details_mode: option.value } })
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection
        title="Thinking"
        description="How reasoning blocks reveal themselves in the transcript. Stored on this device until the daemon carries the setting."
        contentClassName="grid gap-3 md:grid-cols-2"
      >
        {THINKING_DISPLAY_OPTIONS.map((option) => (
          <OptionCard
            key={option.value}
            label={option.label}
            description={option.description}
            selected={current.conversation.thinking_display === option.value}
            onSelect={() =>
              onUpdatePreferences({ conversation: { thinking_display: option.value } })
            }
          />
        ))}
      </SettingsSection>

      <SettingsSection
        title="Auto-expand rules"
        description="Keep risky or high-signal artifacts obvious even when read-only chatter is grouped."
        contentClassName="pt-1"
      >
        <SettingList>
          <SwitchRow
            title="Group read-only tool bursts"
            description="Collapse consecutive file reads, searches, and similar inspection commands into a compact summary row."
            checked={current.conversation.group_read_only_tools}
            onCheckedChange={(next) =>
              onUpdatePreferences({ conversation: { group_read_only_tools: next } })
            }
          />
          <SwitchRow
            title="Collapse long messages you send"
            description="Clamp a pasted wall of text to a few lines with a Show more fade. Handoff prompts especially benefit."
            checked={current.conversation.collapse_long_user_messages}
            onCheckedChange={(next) =>
              onUpdatePreferences({ conversation: { collapse_long_user_messages: next } })
            }
          />
          <SwitchRow
            title="Show expand/collapse all controls"
            description="Expose quick thread-level controls above the conversation when tool cards are present."
            checked={current.conversation.show_expand_all_controls}
            onCheckedChange={(next) =>
              onUpdatePreferences({ conversation: { show_expand_all_controls: next } })
            }
          />
          <SwitchRow
            title="Auto-open approvals"
            description="Always expand approval-related artifacts so side effects stay obvious."
            checked={current.conversation.auto_expand.approvals}
            onCheckedChange={(next) =>
              onUpdatePreferences({ conversation: { auto_expand: { approvals: next } } })
            }
          />
          <SwitchRow
            title="Auto-open errors"
            description="Surface and expand failed calls immediately in the summarizing views. The collapsed view always folds them in — the agent still explains failures that blocked it."
            checked={current.conversation.auto_expand.errors}
            onCheckedChange={(next) =>
              onUpdatePreferences({ conversation: { auto_expand: { errors: next } } })
            }
          />
          <SwitchRow
            title="Auto-open failed tests"
            description="Keep failing test runs visible and expanded even when successful inspection bursts are collapsed."
            checked={current.conversation.auto_expand.failed_tests}
            onCheckedChange={(next) =>
              onUpdatePreferences({ conversation: { auto_expand: { failed_tests: next } } })
            }
          />
          <SwitchRow
            title="Auto-open the first diff"
            description="Keep the first patch in a thread visible even when inspection noise is collapsed."
            checked={current.conversation.auto_expand.first_diff}
            onCheckedChange={(next) =>
              onUpdatePreferences({ conversation: { auto_expand: { first_diff: next } } })
            }
          />
        </SettingList>
      </SettingsSection>

      <SettingsSection
        title="Agent status"
        description="Provider-specific readiness for each connected agent, so the composer toggle has real operational context behind it."
        contentClassName="grid gap-3 md:grid-cols-2"
      >
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
        {workspace?.last_error &&
        /could not find|could not be started|failed to start/i.test(workspace.last_error) ? (
          <div className="md:col-span-2">
            <div className="rounded-[var(--fd-radius-lg)] border border-warning/25 bg-warning-muted p-4">
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
          </div>
        ) : null}
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

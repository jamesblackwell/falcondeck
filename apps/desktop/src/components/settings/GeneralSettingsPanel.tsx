import type { FalconDeckPreferences, UpdatePreferencesPayload } from '@falcondeck/client-core'
import {
  DEFAULT_CLAUDE_AUTOCOMPACT_TOKENS,
  MAX_MAX_AGENT_CHILDREN,
  MIN_MAX_AGENT_CHILDREN,
  normalizePreferences,
} from '@falcondeck/client-core'
import {
  ActivityDiamond,
  Badge,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SettingList,
  SettingRow,
  SettingsPage,
  SettingsPageHeader,
  SettingsSection,
  SwitchRow,
} from '@falcondeck/ui'

import { Download, FolderSync, RotateCcw } from 'lucide-react'
import { useEffect, useState } from 'react'

import type { AppUpdaterState } from '../../hooks/useAppUpdater'
import {
  formatDateTime,
  formatRelative,
  updateBadgeVariant,
  updateStatusLabel,
} from './settings-utils'

/** Commits on blur or Enter so a half-typed value never reaches the daemon. */
function AgentChildLimitInput({
  value,
  onCommit,
}: {
  value: number
  onCommit: (value: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => setDraft(String(value)), [value])

  const commit = () => {
    const parsed = Number(draft)
    const valid =
      draft.trim() !== '' &&
      Number.isInteger(parsed) &&
      parsed >= MIN_MAX_AGENT_CHILDREN &&
      parsed <= MAX_MAX_AGENT_CHILDREN
    if (!valid) {
      setDraft(String(value))
      return
    }
    if (parsed !== value) onCommit(parsed)
  }

  return (
    <Input
      type="number"
      inputMode="numeric"
      aria-label="Parallel tasks per agent"
      min={MIN_MAX_AGENT_CHILDREN}
      max={MAX_MAX_AGENT_CHILDREN}
      step={1}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
      }}
      className="w-20 text-center tabular-nums"
    />
  )
}

const AUTOCOMPACT_PRESETS = [
  100_000, 150_000, 200_000, 250_000, 300_000, 400_000, 500_000, 750_000, 1_000_000,
]
const CODEX_DEFAULT = 'default'

function formatTokens(tokens: number) {
  return tokens >= 1_000_000 ? `${tokens / 1_000_000}M` : `${Math.round(tokens / 1000)}K`
}

/** Presets cover the range; a value set elsewhere (API, file) still shows as itself. */
function AutocompactSelect({
  label,
  value,
  allowDefault,
  onChange,
}: {
  label: string
  value: number | null
  allowDefault?: boolean
  onChange: (value: number | null) => void
}) {
  const options =
    value !== null && !AUTOCOMPACT_PRESETS.includes(value)
      ? [...AUTOCOMPACT_PRESETS, value].sort((a, b) => a - b)
      : AUTOCOMPACT_PRESETS
  return (
    <Select
      value={value === null ? CODEX_DEFAULT : String(value)}
      onValueChange={(next) => onChange(next === CODEX_DEFAULT ? null : Number(next))}
    >
      <SelectTrigger aria-label={label} className="h-8 w-[10.5rem] text-fg-primary">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {allowDefault ? <SelectItem value={CODEX_DEFAULT}>Codex default</SelectItem> : null}
        {options.map((tokens) => (
          <SelectItem key={tokens} value={String(tokens)}>
            {formatTokens(tokens)} tokens
            {tokens === DEFAULT_CLAUDE_AUTOCOMPACT_TOKENS && !allowDefault ? ' (default)' : ''}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

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
        title="Agents"
        description="Limits and context size for agents and bots."
      >
        <SettingList>
          <SwitchRow
            title="Stable instructions for all bots"
            description="Use the system slot on Claude and Codex instead of repeating bot guidance in each message. Context files stay on disk. Applies on the next dispatched turn."
            checked={current.bot_system_context_enabled === true}
            onCheckedChange={(enabled) => onUpdatePreferences({ bot_system_context_enabled: enabled })}
          />
          <SettingRow
            title="Parallel tasks per agent"
            description={`How many tasks one agent or bot can run at once. Default 5, from ${MIN_MAX_AGENT_CHILDREN} to ${MAX_MAX_AGENT_CHILDREN}.`}
            control={
              <AgentChildLimitInput
                value={current.max_agent_children ?? 5}
                onCommit={(max_agent_children) => onUpdatePreferences({ max_agent_children })}
              />
            }
          />
          <SettingRow
            title="Compact Claude conversations at"
            description="Smaller is cheaper on long threads; the 1M model options keep the full window."
            control={
              <AutocompactSelect
                label="Compact Claude conversations at"
                value={current.claude_autocompact_tokens ?? DEFAULT_CLAUDE_AUTOCOMPACT_TOKENS}
                onChange={(tokens) =>
                  tokens !== null && onUpdatePreferences({ claude_autocompact_tokens: tokens })
                }
              />
            }
          />
          <SettingRow
            title="Compact Codex conversations at"
            description="Smaller is cheaper on long threads; Codex default leaves the point to Codex."
            control={
              <AutocompactSelect
                label="Compact Codex conversations at"
                allowDefault
                value={current.codex_autocompact_tokens ?? null}
                onChange={(tokens) => onUpdatePreferences({ codex_autocompact_tokens: tokens })}
              />
            }
          />
          <SwitchRow
            title="Review inbox"
            description="Let agents and bots send you decisions to review, with their files. Off hides Reviews, and they reply in the conversation instead."
            checked={current.review_inbox_enabled === true}
            onCheckedChange={(enabled) => onUpdatePreferences({ review_inbox_enabled: enabled })}
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

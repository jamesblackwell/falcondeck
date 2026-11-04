import { Button, CopyButton, SegmentedControl, SettingList, SettingRow, SettingsSection, SwitchRow } from '@falcondeck/ui'
import type { AnalyticsClearTarget, AnalyticsSettings, AnalyticsStatus } from '@falcondeck/client-core'

import { bytes } from './analytics-utils'

const RETENTION: Array<{ value: string; label: string }> = [
  { value: '3', label: '3 months' },
  { value: '6', label: '6 months' },
  { value: '12', label: '1 year' },
  { value: '24', label: '2 years' },
]

export function RecordingTab({
  status,
  confirming,
  onConfirm,
  onClear,
  onSave,
}: {
  status: AnalyticsStatus | null
  confirming: AnalyticsClearTarget | null
  onConfirm: (target: AnalyticsClearTarget | null) => void
  onClear: (target: AnalyticsClearTarget) => void
  onSave: (patch: Partial<AnalyticsSettings>) => void
}) {
  return (
    <SettingsSection title="Recording" description="Everything is stored as plain files in FalconDeck's folder on this Mac.">
      <SettingList>
        <SwitchRow
          title="Record activity"
          description="Counts, timings and file paths. No message content except your own messages, below."
          checked={status?.settings.enabled ?? true}
          disabled={!status}
          onCheckedChange={(enabled) => onSave({ enabled })}
        />
        <SwitchRow
          title="Record token usage"
          description="Per-turn tokens and provider-reported cost by bot, harness and model. Independent of activity recording above."
          checked={status?.settings.record_usage ?? true}
          disabled={!status}
          onCheckedChange={(record_usage) => onSave({ record_usage })}
        />
        <SwitchRow
          title="Keep your messages"
          description="Save the full text of what you send to agents so you can search it later."
          checked={status?.settings.record_prompts ?? true}
          disabled={!status || !status.settings.enabled}
          onCheckedChange={(record_prompts) => onSave({ record_prompts })}
        />
        <SettingRow
          title="Keep activity for"
          description="Older activity is deleted automatically. Your messages are kept until you delete them."
          control={
            <SegmentedControl
              ariaLabel="Keep activity for"
              value={String(status?.settings.retention_months ?? 12)}
              onChange={(value) => onSave({ retention_months: Number(value) })}
              options={RETENTION}
            />
          }
        />
        {(status?.usage_health ?? []).map((health) => (
          <SettingRow
            key={health.provider}
            title={`${health.provider} usage capture`}
            description="Since daemon startup, while usage recording is enabled. Includes failed and interrupted turns."
            control={
              <span className="text-[length:var(--fd-text-xs)] tabular-nums text-fg-secondary">
                {health.completed_turns} completed · {health.usage_records_written} records · {health.missing_usage_turns} missing usage
              </span>
            }
          />
        ))}
        <SettingRow
          title="Storage"
          description={
            status ? (
              <span className="flex items-center gap-1.5">
                <span className="fd-type-mono min-w-0 truncate" title={status.folder}>
                  {status.folder}
                </span>
                <CopyButton text={status.folder} label="Copy folder path" />
              </span>
            ) : (
              'Not connected'
            )
          }
          control={
            <span className="text-[length:var(--fd-text-xs)] tabular-nums text-fg-tertiary">
              {status
                ? `${bytes(status.events_bytes)} activity · ${bytes(status.usage_bytes ?? 0)} usage · ${bytes(status.prompts_bytes)} messages`
                : '—'}
            </span>
          }
        />
      </SettingList>
      <div className="flex flex-wrap items-center gap-2">
        {confirming ? (
          <>
            <p className="min-w-0 flex-1 text-[length:var(--fd-text-sm)] text-fg-secondary">
              {confirming === 'prompts'
                ? 'Delete every recorded message you sent? This cannot be undone.'
                : confirming === 'usage'
                  ? 'Delete all recorded token usage? This cannot be undone.'
                  : 'Delete all recorded activity? This cannot be undone.'}
            </p>
            <Button variant="ghost" size="sm" onClick={() => onConfirm(null)}>
              Cancel
            </Button>
            <Button variant="danger" size="sm" onClick={() => onClear(confirming)}>
              Delete
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="sm" disabled={!status} onClick={() => onConfirm('prompts')}>
              Delete your messages
            </Button>
            <Button variant="ghost" size="sm" disabled={!status} onClick={() => onConfirm('events')}>
              Delete activity
            </Button>
            <Button variant="ghost" size="sm" disabled={!status} onClick={() => onConfirm('usage')}>
              Delete token usage
            </Button>
          </>
        )}
      </div>
    </SettingsSection>
  )
}

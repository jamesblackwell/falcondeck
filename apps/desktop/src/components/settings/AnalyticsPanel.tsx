import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, SegmentedControl, SettingsPage, SettingsPageHeader, cn } from '@falcondeck/ui'
import {
  createDaemonApiClient,
  type AnalyticsClearTarget,
  type AnalyticsPrompt,
  type AnalyticsSettings,
  type AnalyticsStatus,
  type AnalyticsSummary,
  type AnalyticsUsageReport,
} from '@falcondeck/client-core'
import { RefreshCw } from 'lucide-react'

import { ActivityTab } from './analytics/ActivityTab'
import { LoadingTab, NOTE } from './analytics/analytics-ui'
import {
  ANALYTICS_SETTING_TABS,
  ANALYTICS_TABS,
  NO_SCHEDULED_FILTERS,
  NO_THREAD_FILTERS,
  readStoredTab,
  storeTab,
  type AnalyticsTab,
} from './analytics/analytics-utils'
import { MessagesTab } from './analytics/MessagesTab'
import { OverviewTab } from './analytics/OverviewTab'
import { RecordingTab } from './analytics/RecordingTab'
import { ScheduledTab } from './analytics/ScheduledTab'
import { ThreadsTab } from './analytics/ThreadsTab'
import { TokensTab } from './analytics/TokensTab'

export type AnalyticsPanelProps = {
  baseUrl: string | null
  onToast: (toast: {
    variant: 'success' | 'danger' | 'warning' | 'default'
    title: string
    description?: string
  }) => void
  /** Opens a thread by id; when absent, thread titles stay plain text. */
  onOpenAutomation?: (id: string) => void
  onOpenThread?: (workspaceId: string, threadId: string) => void
  /** A deep link to an on-page title; a fresh object per request opens its tab. */
  focusRequest?: { setting: string } | null
}

type Period = '7' | '30' | '90'

const requestedTab = (focus: AnalyticsPanelProps['focusRequest']) =>
  focus ? ANALYTICS_SETTING_TABS[focus.setting] : undefined

export function AnalyticsPanel({ baseUrl, onToast, onOpenThread, onOpenAutomation, focusRequest }: AnalyticsPanelProps) {
  const api = useMemo(() => (baseUrl ? createDaemonApiClient(baseUrl) : null), [baseUrl])
  const [tab, setTab] = useState<AnalyticsTab>(() => requestedTab(focusRequest) ?? readStoredTab())
  const [period, setPeriod] = useState<Period>('30')
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null)
  const [status, setStatus] = useState<AnalyticsStatus | null>(null)
  const [threadUsage, setThreadUsage] = useState<AnalyticsUsageReport | null>(null)
  const [prompts, setPrompts] = useState<AnalyticsPrompt[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<AnalyticsClearTarget | null>(null)
  // Filters live here so they survive switching tabs.
  const [threadFilters, setThreadFilters] = useState(NO_THREAD_FILTERS)
  const [scheduledFilters, setScheduledFilters] = useState(NO_SCHEDULED_FILTERS)
  // Only the latest load may update the page; an older, slower one is discarded.
  const loadId = useRef(0)
  // Saves run one at a time from the latest wanted settings, so a quick second
  // change cannot be overwritten by the first request's stale values.
  const wanted = useRef<AnalyticsSettings | null>(null)
  const saving = useRef<Promise<void>>(Promise.resolve())

  const load = useCallback(async () => {
    if (!api) return
    const id = ++loadId.current
    setLoading(true)
    setError(null)
    try {
      const [nextSummary, nextStatus] = await Promise.all([
        api.analyticsSummary(Number(period)),
        api.analyticsStatus(),
      ])
      if (id !== loadId.current) return
      setSummary(nextSummary)
      setStatus(nextStatus)
      wanted.current ??= nextStatus.settings
      // Older daemons lack the usage endpoint; the tables simply stay empty
      // instead of blanking the whole panel.
      const report = await api.analyticsUsage(Number(period), 'thread').catch(() => null)
      if (id !== loadId.current) return
      setThreadUsage(report)
    } catch (err) {
      if (id === loadId.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (id === loadId.current) setLoading(false)
    }
  }, [api, period])

  useEffect(() => {
    void load()
  }, [load])

  const selectTab = useCallback((next: AnalyticsTab) => {
    setTab(next)
    storeTab(next)
  }, [])

  useEffect(() => {
    const requested = requestedTab(focusRequest)
    if (requested) selectTab(requested)
  }, [focusRequest, selectTab])

  useEffect(() => {
    if (!api) return
    let active = true
    const timer = window.setTimeout(() => {
      api.analyticsPrompts(query, 100).then(
        (next) => active && setPrompts(next),
        () => active && setPrompts([]),
      )
    }, 200)
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [api, query, status?.prompts_bytes])

  const saveSettings = (patch: Partial<AnalyticsSettings>) => {
    if (!api || !status) return
    const next = { ...(wanted.current ?? status.settings), ...patch }
    wanted.current = next
    setStatus((current) => (current ? { ...current, settings: next } : current))
    saving.current = saving.current.then(async () => {
      try {
        const saved = await api.updateAnalyticsSettings(next)
        // A later change is queued behind this one; keep showing it.
        if (wanted.current === next) setStatus(saved)
      } catch (err) {
        // Show what the daemon actually has unless a newer change is queued.
        if (wanted.current === next) {
          const confirmed = await api.analyticsStatus().catch(() => null)
          if (confirmed && wanted.current === next) {
            wanted.current = confirmed.settings
            setStatus(confirmed)
          }
        }
        onToast({
          variant: 'danger',
          title: 'Could not save analytics settings',
          description: err instanceof Error ? err.message : String(err),
        })
      }
    })
  }

  const clear = async (target: AnalyticsClearTarget) => {
    if (!api) return
    try {
      setStatus(await api.clearAnalytics(target))
      setConfirming(null)
      await load()
      onToast({
        variant: 'success',
        title:
          target === 'prompts'
            ? 'Your messages were deleted'
            : target === 'usage'
              ? 'Token usage history was deleted'
              : 'Activity history was deleted',
      })
    } catch (err) {
      onToast({
        variant: 'danger',
        title: 'Could not delete analytics',
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <SettingsPage>
      <SettingsPageHeader
        title="Analytics"
        description="A private record of how you and your agents work. It stays on this Mac and is never sent to your phone or the relay."
        actions={
          <>
            <SegmentedControl
              ariaLabel="Period"
              value={period}
              onChange={setPeriod}
              options={[
                { value: '7', label: '7 days' },
                { value: '30', label: '30 days' },
                { value: '90', label: '90 days' },
              ]}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Refresh analytics"
              disabled={!api || loading}
              onClick={() => void load()}
            >
              <RefreshCw className={cn('h-4 w-4', loading ? 'animate-spin' : null)} />
            </Button>
          </>
        }
      />
      <SegmentedControl
        kind="tabs"
        ariaLabel="Analytics sections"
        value={tab}
        onChange={selectTab}
        options={ANALYTICS_TABS}
        className="flex w-fit max-w-full overflow-x-auto [&>button]:shrink-0 [&>button]:whitespace-nowrap"
      />
      {error ? (
        <p role="alert" className="text-[length:var(--fd-text-sm)] text-danger">
          {error}
        </p>
      ) : null}

      <div role="tabpanel" aria-label={ANALYTICS_TABS.find((option) => option.value === tab)?.label} className="space-y-6">
        {tab === 'recording' ? (
          <RecordingTab
            status={status}
            confirming={confirming}
            onConfirm={setConfirming}
            onClear={(target) => void clear(target)}
            onSave={saveSettings}
          />
        ) : !api ? (
          <p className={NOTE}>Connect to the daemon to see analytics.</p>
        ) : !summary ? (
          error ? null : <LoadingTab />
        ) : tab === 'overview' ? (
          <OverviewTab summary={summary} usageTotals={threadUsage?.totals ?? null} />
        ) : tab === 'tokens' ? (
          <TokensTab summary={summary} />
        ) : tab === 'threads' ? (
          <ThreadsTab
            rows={threadUsage?.rows ?? []}
            filters={threadFilters}
            onFilters={setThreadFilters}
            onOpenThread={onOpenThread}
          />
        ) : tab === 'scheduled' ? (
          <ScheduledTab
            automations={summary.automations ?? []}
            filters={scheduledFilters}
            onFilters={setScheduledFilters}
            onOpenAutomation={onOpenAutomation}
          />
        ) : tab === 'activity' ? (
          <ActivityTab summary={summary} />
        ) : (
          <MessagesTab projects={summary.projects} prompts={prompts} query={query} onQuery={setQuery} />
        )}
      </div>
    </SettingsPage>
  )
}

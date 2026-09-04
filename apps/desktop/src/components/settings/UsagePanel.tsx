import { useCallback, useEffect, useState } from 'react'

import { ProviderIcon } from '@falcondeck/chat-ui'
import {
  ActivityDiamond,
  Badge,
  Button,
  Card,

  SettingsPage,

  SettingsPageHeader,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@falcondeck/ui'
import type {
  ConsumeProviderResetCreditResponse,
  ProviderUsage,
  ProviderUsageOverview,
  ProviderUsageResetCredit,
  ProviderUsageResetCredits,
  ProviderUsageWindow,
} from '@falcondeck/client-core'
import { RefreshCw } from 'lucide-react'

import { falconDeckHttpError } from '../../connection-copy'
import { formatRelative } from './settings-utils'

export type UsagePanelProps = {
  baseUrl: string | null
  onToast: (toast: {
    variant: 'success' | 'danger' | 'warning' | 'default'
    title: string
    description?: string
  }) => void
  hideHeader?: boolean
}

type ProviderConfig = {
  key: keyof ProviderUsageOverview
  /** Provider id understood by `ProviderIcon` and provider marks. */
  providerId: string
  name: string
  signInHint: string
  expiredHint: string
}

const PROVIDERS: ProviderConfig[] = [
  {
    key: 'codex',
    providerId: 'codex',
    name: 'Codex',
    signInHint: 'Run `codex login` to sign in and see your usage.',
    expiredHint: 'Your Codex session expired. Run `codex`, then reload usage.',
  },
  {
    key: 'claude_code',
    providerId: 'claude',
    name: 'Claude Code',
    signInHint: 'Run `claude` to sign in and see your usage.',
    expiredHint: 'Your Claude session expired. Run `claude`, then reload usage.',
  },
  {
    key: 'agy',
    providerId: 'agy',
    name: 'Antigravity',
    signInHint: 'Run `agy` to sign in and see your usage.',
    expiredHint: 'Your Antigravity session expired. Run `agy`, then reload usage.',
  },
  {
    key: 'grok',
    providerId: 'grok',
    name: 'Grok',
    signInHint: 'Run `grok login` to sign in and see your usage.',
    expiredHint: 'Your Grok session expired. Run `grok login`, then reload usage.',
  },
  {
    key: 'cursor',
    providerId: 'cursor',
    name: 'Cursor',
    signInHint: 'Run `cursor-agent login` to sign in and see your usage.',
    expiredHint: 'Your Cursor session expired. Run `cursor-agent login`, then reload usage.',
  },
  {
    key: 'zai',
    providerId: 'zai',
    name: 'Z.AI',
    signInHint: 'Add a Z.AI coding-plan API key with `opencode auth login`, then reload usage.',
    expiredHint:
      'Your Z.AI coding-plan API key was rejected. Add a new key with `opencode auth login`, then reload usage.',
  },
]

function barColorClass(usedPercent: number): string {
  if (usedPercent >= 95) return 'bg-danger'
  if (usedPercent >= 80) return 'bg-warning'
  return 'bg-accent'
}

function formatReset(resetsAt: string | null): string | null {
  if (!resetsAt) return null
  const reset = new Date(resetsAt)
  if (Number.isNaN(reset.getTime())) return null
  const diffMs = reset.getTime() - Date.now()
  if (diffMs <= 0) return 'Resetting now'

  const diffMinutes = Math.round(diffMs / 60_000)
  if (diffMinutes < 60) return `Resets in ${diffMinutes} min`

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) {
    const minutes = diffMinutes % 60
    return minutes > 0 ? `Resets in ${diffHours} hr ${minutes} min` : `Resets in ${diffHours} hr`
  }

  const withinWeek = diffMs < 7 * 24 * 60 * 60_000
  const formatted = reset.toLocaleString(undefined, {
    weekday: withinWeek ? 'short' : undefined,
    month: withinWeek ? undefined : 'short',
    day: withinWeek ? undefined : 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
  return `Resets ${formatted}`
}

function usageWindowValue(window: ProviderUsageWindow): string {
  if (!window.cost) return `${window.used_percent}% used`
  const used = window.cost.used_usd_cents / 100
  const limit = window.cost.limit_usd_cents / 100
  return `$${used.toFixed(2)} / $${limit % 1 === 0 ? limit.toFixed(0) : limit.toFixed(2)}`
}

function usageIdentity(usage: ProviderUsage | undefined): {
  planLabel: string | null
  accountEmail: string | null
} {
  if (usage?.status === 'ok' || usage?.status === 'error') {
    return {
      planLabel: usage.plan_label ?? null,
      accountEmail: usage.account_email ?? null,
    }
  }
  return { planLabel: null, accountEmail: null }
}

function resetCreditsFrom(usage: ProviderUsage | undefined): ProviderUsageResetCredits | null {
  if (usage?.status !== 'ok') return null
  const credits = usage.reset_credits
  if (!credits || (credits.available_count <= 0 && credits.credits.length === 0)) return null
  return credits
}

function formatCreditExpiry(expiresAt: string | null | undefined): string | null {
  if (!expiresAt) return null
  const expires = new Date(expiresAt)
  if (Number.isNaN(expires.getTime())) return null
  if (expires.getTime() <= Date.now()) return 'Expired'
  return `Expires ${expires.toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })}`
}

function consumeOutcomeToast(
  outcome: ConsumeProviderResetCreditResponse['outcome'],
): {
  variant: 'success' | 'danger' | 'warning' | 'default'
  title: string
  description?: string
} {
  switch (outcome) {
    case 'reset':
      return { variant: 'success', title: 'Codex usage limits were reset' }
    case 'nothing_to_reset':
      return {
        variant: 'default',
        title: 'Nothing to reset',
        description: 'This credit is still available.',
      }
    case 'no_credit':
      return { variant: 'warning', title: 'No Codex reset credits available' }
    case 'already_redeemed':
      return { variant: 'default', title: 'That reset was already used' }
  }
}

function UsageWindowRow({ window }: { window: ProviderUsageWindow }) {
  const reset = formatReset(window.resets_at)
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[length:var(--fd-text-sm)] text-fg-primary">{window.label}</span>
        <span className="text-[length:var(--fd-text-xs)] tabular-nums text-fg-muted">
          {usageWindowValue(window)}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={window.label}
        aria-valuenow={window.used_percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 w-full overflow-hidden rounded-[var(--fd-radius-full)] bg-surface-3"
      >
        <div
          className={`h-full rounded-[var(--fd-radius-full)] ${barColorClass(window.used_percent)}`}
          style={{ width: `${Math.max(window.used_percent, 2)}%` }}
        />
      </div>
      {reset ? (
        <p className="text-[length:var(--fd-text-xs)] text-fg-muted">{reset}</p>
      ) : null}
    </div>
  )
}

function UsageResetCredits({
  credits,
  consumingId,
  onUseReset,
}: {
  credits: ProviderUsageResetCredits
  consumingId: string | null
  onUseReset: (credit: ProviderUsageResetCredit | null) => void
}) {
  const rows =
    credits.credits.length > 0
      ? credits.credits
      : [{ id: 'available', title: 'Full reset' }]
  const unnamed = credits.credits.length === 0
  return (
    <div className="space-y-2">
      <p className="text-[length:var(--fd-text-xs)] font-medium text-fg-secondary">
        Usage limit resets
      </p>
      <div className="overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-subtle">
        {rows.map((credit, index) => {
          const expiry = formatCreditExpiry(credit.expires_at)
          const busy = consumingId != null
          return (
            <div
              key={credit.id}
              className={`flex items-center justify-between gap-3 px-3 py-2.5 ${
                index > 0 ? 'border-t border-border-subtle' : ''
              }`}
            >
              <div className="min-w-0">
                <p className="text-[length:var(--fd-text-sm)] text-fg-primary">{credit.title}</p>
                {expiry ? (
                  <p className="text-[length:var(--fd-text-xs)] text-fg-muted">{expiry}</p>
                ) : unnamed ? (
                  <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
                    {credits.available_count === 1
                      ? '1 reset available'
                      : `${credits.available_count} resets available`}
                  </p>
                ) : null}
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={busy || expiry === 'Expired'}
                onClick={() => onUseReset(unnamed ? null : credit)}
              >
                {busy && (consumingId === credit.id || consumingId === '*') ? (
                  <ActivityDiamond size="md" tone="current" />
                ) : null}
                Use reset
              </Button>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function UsageBody({
  config,
  usage,
  consumingId,
  onUseReset,
}: {
  config: ProviderConfig
  usage: ProviderUsage | undefined
  consumingId: string | null
  onUseReset: (credit: ProviderUsageResetCredit | null) => void
}) {
  if (!usage) {
    return (
      <p className="text-[length:var(--fd-text-sm)] text-fg-muted">Reading usage…</p>
    )
  }
  switch (usage.status) {
    case 'ok': {
      const resetCredits = resetCreditsFrom(usage)
      if (usage.windows.length === 0 && !resetCredits) {
        return (
          <p className="text-[length:var(--fd-text-sm)] text-fg-muted">
            No usage limits reported for this plan.
          </p>
        )
      }
      return (
        <div className="space-y-3">
          {usage.windows.map((window, index) => (
            <UsageWindowRow key={`${window.label}-${index}`} window={window} />
          ))}
          {resetCredits && config.key === 'codex' ? (
            <UsageResetCredits
              credits={resetCredits}
              consumingId={consumingId}
              onUseReset={onUseReset}
            />
          ) : null}
        </div>
      )
    }
    case 'unauthenticated':
      return (
        <p className="text-[length:var(--fd-text-sm)] text-fg-muted">{config.signInHint}</p>
      )
    case 'expired':
      return (
        <p className="text-[length:var(--fd-text-sm)] text-fg-muted">{config.expiredHint}</p>
      )
    case 'error':
      return (
        <p className="text-[length:var(--fd-text-sm)] text-fg-muted">{usage.message}</p>
      )
    default:
      return null
  }
}

export function UsagePanel({ baseUrl, onToast, hideHeader = false }: UsagePanelProps) {
  const [overview, setOverview] = useState<ProviderUsageOverview | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [consumingId, setConsumingId] = useState<string | null>(null)

  const fetchOverview = useCallback(
    async (mode: 'initial' | 'refresh') => {
      if (!baseUrl) return
      if (mode === 'refresh') setIsLoading(true)
      try {
        const url =
          mode === 'refresh'
            ? `${baseUrl}/api/provider-usage?refresh=true`
            : `${baseUrl}/api/provider-usage`
        const response = await fetch(url)
        if (!response.ok) throw new Error(falconDeckHttpError(response.status))
        setOverview((await response.json()) as ProviderUsageOverview)
        setLoadError(null)
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        if (mode === 'refresh') {
          onToast({
            variant: 'danger',
            title: 'Could not reload usage',
            description: message,
          })
        } else {
          setLoadError(message)
        }
      } finally {
        if (mode === 'refresh') setIsLoading(false)
      }
    },
    [baseUrl, onToast],
  )

  useEffect(() => {
    void fetchOverview('initial')
  }, [fetchOverview])

  const handleUseReset = useCallback(
    async (credit: ProviderUsageResetCredit | null) => {
      if (!baseUrl || consumingId) return
      const confirmed = window.confirm(
        'Using this reset refreshes your 5-hour and weekly Codex limits and moves the weekly reset date to about seven days from now. Use it?',
      )
      if (!confirmed) return
      const consumeKey = credit?.id ?? '*'
      setConsumingId(consumeKey)
      try {
        const response = await fetch(
          `${baseUrl}/api/provider-usage/codex/reset-credits/consume`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              credit_id: credit?.id ?? null,
            }),
          },
        )
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null
          throw new Error(payload?.error ?? falconDeckHttpError(response.status))
        }
        const result = (await response.json()) as ConsumeProviderResetCreditResponse
        setOverview(result.usage)
        onToast(consumeOutcomeToast(result.outcome))
      } catch (cause) {
        onToast({
          variant: 'danger',
          title: 'Could not use Codex reset',
          description: cause instanceof Error ? cause.message : String(cause),
        })
      } finally {
        setConsumingId(null)
      }
    },
    [baseUrl, consumingId, onToast],
  )

  const visibleProviders = PROVIDERS.filter((config) => {
    const usage = overview?.[config.key]
    // Older daemons omit `grok`; treat a missing snapshot as not installed.
    return usage != null && usage.status !== 'not_installed'
  })

  return (
    <SettingsPage>
      {!hideHeader ? (
        <SettingsPageHeader
          title="Usage"
          description="How much of your Codex, Claude Code, Antigravity, Grok, Cursor, and Z.AI subscriptions you&apos;ve used on this Mac. Credentials stay with each CLI — FalconDeck only reads the numbers."
        />
      ) : null}

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle>Subscription limits</CardTitle>
            <CardDescription>
              Session windows roll over every few hours; weekly limits reset with your plan.
              {overview?.refreshed_at ? (
                <>
                  {' '}
                  Last refreshed {formatRelative(overview.refreshed_at)}.
                </>
              ) : null}
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="secondary"
            disabled={!baseUrl || isLoading}
            onClick={() => void fetchOverview('refresh')}
          >
            {isLoading ? (
              <ActivityDiamond size="md" tone="current" />
            ) : (
              <RefreshCw className="h-4 w-4" />
            )}
            Reload
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {loadError ? (
            <div className="flex items-center gap-3 px-2 py-4">
              <p className="text-[length:var(--fd-text-sm)] text-danger">{loadError}</p>
              <Button size="sm" variant="secondary" onClick={() => void fetchOverview('initial')}>
                Retry
              </Button>
            </div>
          ) : !overview ? (
            <div className="flex items-center justify-center gap-2 px-2 py-10 text-[length:var(--fd-text-sm)] text-fg-muted">
              <ActivityDiamond size="md" />
              Reading usage…
            </div>
          ) : visibleProviders.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-[var(--fd-radius-lg)] border border-dashed border-border-subtle px-6 py-10 text-center">
              <p className="text-[length:var(--fd-text-sm)] text-fg-secondary">
                No supported subscriptions detected yet. Install Codex, Claude Code, Antigravity,
                Grok, or Cursor, or add a Z.AI coding-plan key, to see usage.
              </p>
            </div>
          ) : (
            visibleProviders.map((config) => {
              const usage = overview[config.key]
              // Error payloads still carry the locally-known plan and account,
              // so an outage does not blank which subscription this is.
              const { planLabel, accountEmail } = usageIdentity(usage)
              return (
                <div
                  key={config.key}
                  className="rounded-[var(--fd-radius-lg)] border border-border-subtle px-4 py-3"
                >
                  <div className="flex items-center gap-3">
                    <ProviderIcon
                      provider={config.providerId}
                      className="h-4 w-4 text-fg-muted"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                          {config.name}
                        </span>
                        {planLabel ? <Badge variant="default">{planLabel}</Badge> : null}
                      </div>
                      {accountEmail ? (
                        <p className="mt-0.5 truncate text-[length:var(--fd-text-xs)] text-fg-muted">
                          {accountEmail}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  <div className="mt-3 space-y-3">
                    <UsageBody
                      config={config}
                      usage={usage}
                      consumingId={config.key === 'codex' ? consumingId : null}
                      onUseReset={handleUseReset}
                    />
                  </div>
                </div>
              )
            })
          )}
        </CardContent>
      </Card>
    </SettingsPage>
  )
}
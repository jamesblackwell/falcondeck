import { fireEvent, within, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AnalyticsPanel } from './AnalyticsPanel'
import type {
  AnalyticsStatus,
  AnalyticsSummary,
  AnalyticsUsageReport,
} from '@falcondeck/client-core'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}

const status: AnalyticsStatus = {
  settings: { enabled: true, record_prompts: true, retention_months: 12 },
  folder: '/Users/me/.falcondeck/analytics',
  events_bytes: 2048,
  prompts_bytes: 512,
}

const usageTotals = {
  input_tokens: 11058,
  cache_read_tokens: 11008,
  cache_write_tokens: 0,
  output_tokens: 257,
  turns: 2,
  cost_usd: 0,
}

const threadUsage: AnalyticsUsageReport = {
  days: 7,
  group: 'thread',
  totals: { ...usageTotals, cost_usd: 0.1195712 },
  rows: [
    {
      key: 'thread-9',
      label: 'Nightly repo check',
      totals: { ...usageTotals, cost_usd: 0.1195712 },
      cost_sources: ['provider_unverified'],
      thread: {
        bot: null,
        workspace: 'ws-1',
        project: 'falcondeck',
        origin: 'automation',
        automation: 'Nightly repo check',
        provider: 'grok',
        model: 'grok-4.7-build',
        avg_context_per_call: 7405,
      },
    },
  ],
}

const summary: AnalyticsSummary = {
  days: 7,
  generated_at: '2026-10-29T12:00:00Z',
  totals: {
    user_messages: 12,
    scheduled_messages: 2,
    agent_messages: 8,
    ack_like_messages: 2,
    delegations: 3,
    turns: 20,
    failed_turns: 1,
    file_writes: 40,
  },
  daily: [
    { date: '2026-10-28', user_messages: 5, agent_messages: 3, turns: 9 },
    { date: '2026-10-29', user_messages: 7, agent_messages: 5, turns: 11 },
  ],
  agent_pairs: [
    { from: 'a', from_title: 'Juno - CPO', to: 'b', to_title: 'Iris - CMO', messages: 8, avg_chars: 240, ack_like: 2 },
  ],
  recent_agent_messages: [
    { at: '2026-10-29T11:00:00Z', from_title: 'Juno - CPO', to_title: 'Iris - CMO', chars: 15, ack_like: true, excerpt: 'Thanks, got it.' },
  ],
  files: [{ path: '/repo/src/app.rs', writes: 9, threads: 2, contested_days: 1 }],
  bots: [
    { name: 'Juno - CPO', turns: 6, avg_turn_ms: 95_000, avg_context_tokens: 2400, delegations: 3, messages_sent: 8 },
  ],
  providers: [
    { provider: 'claude', turns: 20, failed: 1, avg_turn_ms: 60_000, input_tokens: 120_000, output_tokens: 9000, avg_peak_context_tokens: 48_000 },
  ],
  projects: [{ project: 'quizgecko', messages: 12, avg_chars: 180, commits: 5 }],
  triggers: { user: 5, scheduled: 10, agent: 3, delegation: 2, other: 0 },
  waiting: { requests: 2, median_request_wait_ms: 90_000, replies: 4, median_reply_ms: 600_000, p90_reply_ms: 7_200_000 },
  automations: [
    {
      models: ['claude-haiku-5-5', 'claude-sonnet-5-5'],
      configured_model: 'claude-opus-5-5',
      usage: usageTotals,
      id: 'a1',
      name: 'Fast Start Monitor',
      state: 'enabled',
      schedule: 'Every 30 minutes',
      thread_mode: 'new_each_run',
      runs: 15,
      no_action: 12,
      failed: 0,
      skipped: 0,
      threads: 15,
      agent_ms: 900_000,
      flags: ['rarely_useful', 'thread_per_run'],
    },
    {
      id: 'a2', name: 'Quiet task', state: 'enabled', runs: 0, no_action: 0,
      failed: 0, skipped: 0, threads: 0, configured_model: 'claude-opus-5-5',
    },
  ],
  usage: [
    {
      bot: 'Juno - CPO',
      provider: 'claude',
      model: 'claude-haiku-5-5',
      totals: {
        input_tokens: 2,
        cache_read_tokens: 11886,
        cache_write_tokens: 18949,
        output_tokens: 4,
        turns: 1,
        cost_usd: 0.00391086,
      },
      cost_sources: ['provider'],
    },
  ],
}

function stubDaemon() {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/analytics/summary')) return jsonResponse(summary)
    if (url.includes('/api/analytics/usage')) return jsonResponse(threadUsage)
    if (url.includes('/api/analytics/prompts')) {
      return jsonResponse(
        url.includes('query=')
          ? []
          : [
              {
                at: '2026-10-29T10:00:00Z',
                project: 'quizgecko',
                thread_id: 't1',
                title: 'Onboarding',
                provider: 'claude',
                text: 'Ship the fast-start onboarding',
              },
            ],
      )
    }
    if (url.endsWith('/api/analytics/settings')) {
      const settings = JSON.parse(String(init?.body))
      return jsonResponse({ ...status, settings })
    }
    if (url.endsWith('/api/analytics/clear')) return jsonResponse({ ...status, prompts_bytes: 0 })
    return jsonResponse(status)
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('AnalyticsPanel', () => {
  it('shows observed models, differing pin, token breakdown and editor action', async () => {
    stubDaemon()
    const onOpenAutomation = vi.fn()
    render(<AnalyticsPanel baseUrl="http://daemon" onToast={vi.fn()} onOpenAutomation={onOpenAutomation} />)
    expect(await screen.findByText('Haiku 5.5 · Sonnet 5.5')).toBeInTheDocument()
    expect(screen.getByText('Pin: Opus 5.5')).toBeInTheDocument()
    expect(screen.getByTitle(/Input: 11,058 · Cache read: 11,008/)).toHaveTextContent('22k')
    fireEvent.click(screen.getByRole('button', { name: 'Fast Start Monitor' }))
    expect(onOpenAutomation).toHaveBeenCalledWith('a1')
    const table = screen.getByRole('button', { name: /Tokens/ }).closest('table')!
    expect(within(table).getByText('Opus 5.5')).toHaveClass('text-fg-muted')
    fireEvent.click(screen.getByRole('button', { name: /Tokens/ }))
    expect(screen.getByRole('columnheader', { name: /^Tokens ↓$/ })).toHaveAttribute('aria-sort', 'descending')
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Fast Start Monitor')
    fireEvent.click(screen.getByRole('button', { name: /Tokens/ }))
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('Quiet task')
  })

  afterEach(() => vi.unstubAllGlobals())

  it('shows totals, agent chatter, files and your messages', async () => {
    stubDaemon()
    render(<AnalyticsPanel baseUrl="http://daemon" onToast={vi.fn()} />)
    expect(await screen.findByText('25% look like acknowledgements')).toBeInTheDocument()
    // Once in the pairs table, once in the latest messages.
    expect(screen.getAllByText('Juno - CPO → Iris - CMO')).toHaveLength(2)
    expect(screen.getByText('Thanks, got it.')).toBeInTheDocument()
    expect(screen.getByText('/repo/src/app.rs')).toBeInTheDocument()
    expect(screen.getByText('≈2.4k')).toBeInTheDocument()
    expect(await screen.findByText('Ship the fast-start onboarding')).toBeInTheDocument()
    // 15 of 20 turns started without the user.
    expect(screen.getByText('75%')).toBeInTheDocument()
    expect(screen.getByText('10m 0s')).toBeInTheDocument()
    expect(screen.getByText('Fast Start Monitor')).toBeInTheDocument()
    expect(screen.getByText('80%')).toBeInTheDocument()
    expect(screen.getByText('80% found nothing to do')).toBeInTheDocument()
    expect(screen.getByText('Rarely finds anything')).toBeInTheDocument()
    expect(screen.getByText('New thread each run')).toBeInTheDocument()
    expect(screen.getByText(/Every 30 minutes/)).toBeInTheDocument()
    expect(screen.getByText('15m 0s')).toBeInTheDocument()
    // Token usage by bot, harness and model; cost is a labelled secondary.
    expect(screen.getByText('claude-haiku-5-5')).toBeInTheDocument()
    expect(screen.getByText('$0.0039')).toBeInTheDocument()
    // Top threads: title, origin with the automation name, context per call.
    expect(screen.getByText('Nightly repo check')).toBeInTheDocument()
    expect(screen.getByText('grok · grok-4.7-build')).toBeInTheDocument()
    expect(screen.getByText('Automation · Nightly repo check')).toBeInTheDocument()
    expect(screen.getByText('≈7.4k')).toBeInTheDocument()
    expect(screen.getByText('$0.1196')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Search your messages'), { target: { value: 'zzz' } })
    expect(await screen.findByText('No messages match.')).toBeInTheDocument()
  })

  it('saves settings and asks before deleting your messages', async () => {
    const fetch = stubDaemon()
    const onToast = vi.fn()
    render(<AnalyticsPanel baseUrl="http://daemon" onToast={onToast} />)
    fireEvent.click(await screen.findByRole('switch', { name: 'Keep your messages' }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        'http://daemon/api/analytics/settings',
        expect.objectContaining({
          body: JSON.stringify({ enabled: true, record_prompts: false, retention_months: 12 }),
        }),
      ),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Delete your messages' }))
    expect(screen.getByText(/Delete every recorded message you sent/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        'http://daemon/api/analytics/clear',
        expect.objectContaining({ body: JSON.stringify({ target: 'prompts' }) }),
      ),
    )
    await waitFor(() => expect(onToast).toHaveBeenCalledWith({ variant: 'success', title: 'Your messages were deleted' }))
  })

  it('keeps a second quick change when saves overlap', async () => {
    const fetch = stubDaemon()
    render(<AnalyticsPanel baseUrl="http://daemon" onToast={vi.fn()} />)
    fireEvent.click(await screen.findByRole('switch', { name: 'Keep your messages' }))
    fireEvent.click(screen.getByRole('button', { name: '2 years' }))
    await waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        'http://daemon/api/analytics/settings',
        expect.objectContaining({
          body: JSON.stringify({ enabled: true, record_prompts: false, retention_months: 24 }),
        }),
      ),
    )
    expect(screen.getByRole('switch', { name: 'Keep your messages' })).toHaveAttribute('aria-checked', 'false')
  })

  it('shows the saved setting again when a save fails', async () => {
    const fetch = stubDaemon()
    const onToast = vi.fn()
    fetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/analytics/settings')) throw new Error('daemon offline')
      if (url.includes('/api/analytics/summary')) return jsonResponse(summary)
      if (url.includes('/api/analytics/prompts')) return jsonResponse([])
      return jsonResponse(status)
    })
    render(<AnalyticsPanel baseUrl="http://daemon" onToast={onToast} />)
    const toggle = await screen.findByRole('switch', { name: 'Keep your messages' })
    fireEvent.click(toggle)
    await waitFor(() => expect(onToast).toHaveBeenCalledWith(expect.objectContaining({ variant: 'danger' })))
    expect(screen.getByRole('switch', { name: 'Keep your messages' })).toHaveAttribute('aria-checked', 'true')
  })
})

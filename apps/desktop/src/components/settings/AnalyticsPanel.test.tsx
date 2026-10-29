import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AnalyticsPanel } from './AnalyticsPanel'
import type { AnalyticsStatus, AnalyticsSummary } from '@falcondeck/client-core'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
}

const status: AnalyticsStatus = {
  settings: { enabled: true, record_prompts: true, retention_months: 12 },
  folder: '/Users/me/.falcondeck/analytics',
  events_bytes: 2048,
  prompts_bytes: 512,
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
    { provider: 'claude', turns: 20, failed: 1, avg_turn_ms: 60_000, input_tokens: 120_000, output_tokens: 9000 },
  ],
  projects: [{ project: 'quizgecko', messages: 12, avg_chars: 180 }],
}

function stubDaemon() {
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url.includes('/api/analytics/summary')) return jsonResponse(summary)
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
})

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { UsagePanel } from './UsagePanel'
import type { ProviderUsageOverview } from '@falcondeck/client-core'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function overviewWith(overrides: Partial<ProviderUsageOverview>): ProviderUsageOverview {
  return {
    codex: {
      status: 'ok',
      account_email: 'dev@example.com',
      plan_label: 'Pro',
      windows: [
        {
          label: 'Current session',
          used_percent: 12,
          resets_at: null,
        },
      ],
    },
    claude_code: {
      status: 'ok',
      account_email: null,
      plan_label: 'Max (5x)',
      windows: [
        {
          label: 'Current session',
          used_percent: 87,
          resets_at: '2099-06-19T22:00:00.000Z',
        },
        {
          label: 'Weekly limit',
          used_percent: 41,
          resets_at: null,
        },
      ],
    },
    grok: { status: 'not_installed' },
    cursor: { status: 'not_installed' },
    agy: { status: 'not_installed' },
    ...overrides,
  }
}

describe('UsagePanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('renders plan labels, window rows, and usage bars', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(overviewWith({}))),
    )

    render(<UsagePanel baseUrl="http://127.0.0.1:4317" onToast={vi.fn()} />)

    expect(await screen.findByText('Codex')).toBeInTheDocument()
    expect(screen.getByText('Pro')).toBeInTheDocument()
    expect(screen.getByText('Max (5x)')).toBeInTheDocument()
    expect(screen.getByText('dev@example.com')).toBeInTheDocument()
    expect(screen.getAllByText('12% used').length).toBe(1)
    expect(screen.getAllByText('87% used').length).toBe(1)
    expect(screen.getAllByText('41% used').length).toBe(1)
    expect(screen.getAllByRole('progressbar', { name: 'Current session' }).length).toBe(2)
    expect(screen.getByRole('progressbar', { name: 'Weekly limit' })).toBeInTheDocument()
  })

  it('renders Codex five-hour and weekly windows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          overviewWith({
            claude_code: { status: 'not_installed' },
            codex: {
              status: 'ok',
              account_email: 'dev@example.com',
              plan_label: 'Pro',
              windows: [
                {
                  label: 'Weekly limit',
                  used_percent: 12,
                  resets_at: null,
                },
                {
                  label: '5-hour limit',
                  used_percent: 4,
                  resets_at: '2099-08-30T12:00:00.000Z',
                },
              ],
            },
          }),
        ),
      ),
    )

    render(<UsagePanel baseUrl="http://127.0.0.1:4317" onToast={vi.fn()} />)

    expect(await screen.findByRole('progressbar', { name: '5-hour limit' })).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Weekly limit' })).toBeInTheDocument()
    expect(screen.getByText('4% used')).toBeInTheDocument()
  })

  it('renders Grok weekly usage when the harness is installed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          overviewWith({
            grok: {
              status: 'ok',
              account_email: 'james@example.com',
              plan_label: 'SuperGrok Heavy',
              windows: [
                {
                  label: 'Weekly limit',
                  used_percent: 49,
                  resets_at: '2099-08-23T11:52:18.000Z',
                },
              ],
            },
          }),
        ),
      ),
    )

    render(<UsagePanel baseUrl="http://127.0.0.1:4317" onToast={vi.fn()} />)

    expect(await screen.findByText('Grok')).toBeInTheDocument()
    expect(screen.getByText('SuperGrok Heavy')).toBeInTheDocument()
    expect(screen.getByText('james@example.com')).toBeInTheDocument()
    expect(screen.getByText('49% used')).toBeInTheDocument()
  })

  it('hides Grok when an older daemon omits the field', async () => {
    const payload = overviewWith({})
    delete payload.grok
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload)))

    render(<UsagePanel baseUrl="http://127.0.0.1:4317" onToast={vi.fn()} />)

    expect(await screen.findByText('Codex')).toBeInTheDocument()
    expect(screen.queryByText('Grok')).toBeNull()
  })

  it('renders Cursor monthly spend when the harness is installed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          overviewWith({
            cursor: {
              status: 'ok',
              account_email: 'james@example.com',
              plan_label: 'Ultra',
              windows: [
                {
                  label: 'Monthly limit',
                  used_percent: 95,
                  resets_at: '2099-09-19T07:14:41.000Z',
                  cost: {
                    used_usd_cents: 38168,
                    limit_usd_cents: 40000,
                  },
                },
              ],
            },
          }),
        ),
      ),
    )

    render(<UsagePanel baseUrl="http://127.0.0.1:4317" onToast={vi.fn()} />)

    expect(await screen.findByText('Cursor')).toBeInTheDocument()
    expect(screen.getByText('Ultra')).toBeInTheDocument()
    expect(screen.getByText('$381.68 / $400')).toBeInTheDocument()
    expect(screen.getByRole('progressbar', { name: 'Monthly limit' })).toBeInTheDocument()
  })

  it('renders Antigravity when the harness is installed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          overviewWith({
            agy: {
              status: 'ok',
              account_email: 'james@example.com',
              plan_label: 'Google AI Pro',
              windows: [
                {
                  label: '5-hour limit',
                  used_percent: 22,
                  resets_at: '2099-08-30T12:00:00.000Z',
                },
              ],
            },
          }),
        ),
      ),
    )

    render(<UsagePanel baseUrl="http://127.0.0.1:4317" onToast={vi.fn()} />)

    expect(await screen.findByText('Antigravity')).toBeInTheDocument()
    expect(screen.getByText('Google AI Pro')).toBeInTheDocument()
    expect(screen.getByText('22% used')).toBeInTheDocument()
  })

  it('hides Cursor when an older daemon omits the field', async () => {
    const payload = overviewWith({})
    delete payload.cursor
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(payload)))

    render(<UsagePanel baseUrl="http://127.0.0.1:4317" onToast={vi.fn()} />)

    expect(await screen.findByText('Codex')).toBeInTheDocument()
    expect(screen.queryByText('Cursor')).toBeNull()
  })

  it('hides providers that are not installed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          overviewWith({ codex: { status: 'not_installed' } }),
        ),
      ),
    )

    render(<UsagePanel baseUrl="http://127.0.0.1:4317" onToast={vi.fn()} />)

    expect(await screen.findByText('Claude Code')).toBeInTheDocument()
    expect(screen.queryByText('Codex')).toBeNull()
    expect(screen.queryByText('Pro')).toBeNull()
  })

  it('shows sign-in hints for unauthenticated providers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          overviewWith({ claude_code: { status: 'unauthenticated' } }),
        ),
      ),
    )

    render(<UsagePanel baseUrl="http://127.0.0.1:4317" onToast={vi.fn()} />)

    expect(
      await screen.findByText('Run `claude` to sign in and see your usage.'),
    ).toBeInTheDocument()
  })

  it('shows re-login hints for expired providers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(overviewWith({ codex: { status: 'expired' } })),
      ),
    )

    render(<UsagePanel baseUrl="http://127.0.0.1:4317" onToast={vi.fn()} />)

    expect(
      await screen.findByText(
        'Your Codex session expired. Run `codex`, then reload usage.',
      ),
    ).toBeInTheDocument()
  })

  it('shows provider error messages without inventing numbers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          overviewWith({
            claude_code: {
              status: 'error',
              message: 'Claude usage is rate limited right now. Try again shortly.',
              plan_label: 'Max (5x)',
              account_email: 'dev@example.com',
            },
          }),
        ),
      ),
    )

    render(<UsagePanel baseUrl="http://127.0.0.1:4317" onToast={vi.fn()} />)

    expect(
      await screen.findByText(
        'Claude usage is rate limited right now. Try again shortly.',
      ),
    ).toBeInTheDocument()
    // Known plan from local credentials still surfaces alongside the error.
    expect(screen.getByText('Max (5x)')).toBeInTheDocument()
    expect(screen.queryByText('41% used')).toBeNull()
  })

  it('reloads usage through the refresh button', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(overviewWith({})))
      .mockResolvedValueOnce(
        jsonResponse(
          overviewWith({
            codex: {
              status: 'ok',
              account_email: null,
              plan_label: null,
              windows: [],
            },
          }),
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    render(<UsagePanel baseUrl="http://127.0.0.1:4317" onToast={vi.fn()} />)

    expect(await screen.findByText('12% used')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }))

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2)
    })
    expect(
      await screen.findByText('No usage limits reported for this plan.'),
    ).toBeInTheDocument()
  })

  it('shows an inline retry when the initial load fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 500))
      .mockResolvedValueOnce(jsonResponse(overviewWith({})))
    vi.stubGlobal('fetch', fetchMock)

    render(<UsagePanel baseUrl="http://127.0.0.1:4317" onToast={vi.fn()} />)

    expect(await screen.findByText('FalconDeck returned 500.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))

    expect(await screen.findByText('12% used')).toBeInTheDocument()
  })
})

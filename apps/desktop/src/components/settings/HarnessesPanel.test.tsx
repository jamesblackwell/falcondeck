import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { HarnessesPanel } from './HarnessesPanel'
import type { HostView } from '../../hosts'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const overview = {
  host: 'local',
  harnesses: [
    {
      id: 'codex',
      label: 'Codex',
      kind: 'builtin',
      bin: 'codex',
      resolved_path: '/usr/local/lib/node_modules/@openai/codex/bin/codex',
      installed: true,
      version: '0.12.0',
      latest_version: '0.13.0',
      update_available: true,
      install_source: 'npm',
      upgrade_command: 'npm install -g @openai/codex',
      account_status: 'Logged in using ChatGPT',
    },
    {
      id: 'zcode',
      label: 'Zcode (GLM)',
      kind: 'detected',
      bin: 'zcode',
      installed: false,
    },
  ],
}

const hosts: HostView[] = [
  {
    id: 'host-1',
    name: 'Build box',
    sshTarget: 'build@example.com',
    sshPort: 2222,
    relayUrl: 'https://connect.falcondeck.com',
    enabled: true,
    paired: true,
    needsRepair: false,
    status: 'connected',
    presence: null,
    snapshot: null,
    lastError: null,
  },
]

describe('HarnessesPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('renders install status, versions, and auth lines', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse(overview)),
    )

    render(<HarnessesPanel baseUrl="http://127.0.0.1:4317" hosts={[]} onToast={vi.fn()} />)

    expect(await screen.findByText('Codex')).toBeInTheDocument()
    expect(screen.getByText('Update available')).toBeInTheDocument()
    expect(screen.getByText('v0.12.0 → 0.13.0')).toBeInTheDocument()
    expect(screen.getByText('Logged in using ChatGPT')).toBeInTheDocument()
    // Detection-only harness shows no upgrade button.
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Upgrade' })).toBeInTheDocument()
  })

  it('deep-refreshes through the refresh endpoint when a remote host is selected', async () => {
    const fetchMock = vi
      .fn()
      // Initial local overview load.
      .mockResolvedValueOnce(jsonResponse(overview))
      // Selecting a remote host immediately deep-probes it.
      .mockResolvedValueOnce(
        jsonResponse({ host: 'build@example.com', harnesses: [] }),
      )
      // "Check for updates" re-probes the selected host.
      .mockResolvedValueOnce(
        jsonResponse({ host: 'build@example.com', harnesses: [] }),
      )
    vi.stubGlobal('fetch', fetchMock)

    render(<HarnessesPanel baseUrl="http://127.0.0.1:4317" hosts={hosts} onToast={vi.fn()} />)

    expect(
      await screen.findByText('Logged in using ChatGPT'),
    ).toBeInTheDocument()

    fireEvent.change(await screen.findByLabelText('Host'), {
      target: { value: 'host-1' },
    })

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    const [url, request] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:4317/api/harnesses/refresh')
    expect(request.method).toBe('POST')
    expect(JSON.parse(request.body as string)).toEqual({
      ssh_target: 'build@example.com',
      port: 2222,
    })

    // Local harness rows must never linger under the remote host's name.
    await waitFor(() => expect(screen.queryByText('Codex')).toBeNull())
  })

  it('starts an upgrade and polls the job until it completes', async () => {
    const fetchMock = vi
      .fn()
      // Initial overview load.
      .mockResolvedValueOnce(jsonResponse(overview))
      // Upgrade start.
      .mockResolvedValueOnce(jsonResponse({ job_id: 'job-1' }))
      // First poll fires immediately and sees the job still running…
      .mockResolvedValueOnce(
        jsonResponse({
          job_id: 'job-1',
          harness_id: 'codex',
          label: 'Codex',
          host: 'local',
          status: 'running',
          log: ['added 42 packages'],
        }),
      )
      // …the interval tick sees it finished.
      .mockResolvedValueOnce(
        jsonResponse({
          job_id: 'job-1',
          harness_id: 'codex',
          label: 'Codex',
          host: 'local',
          status: 'completed',
          log: ['added 42 packages'],
        }),
      )
      // Post-completion re-probe.
      .mockResolvedValueOnce(jsonResponse(overview))
    vi.stubGlobal('fetch', fetchMock)
    const onToast = vi.fn()

    render(<HarnessesPanel baseUrl="http://127.0.0.1:4317" hosts={[]} onToast={onToast} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Upgrade' }))
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4317/api/harnesses/upgrade',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4317/api/harnesses/jobs/job-1',
      ),
    )
    await waitFor(
      () => expect(screen.getByText(/added 42 packages/)).toBeInTheDocument(),
      { timeout: 5000 },
    )
    await waitFor(
      () =>
        expect(onToast).toHaveBeenCalledWith(
          expect.objectContaining({ variant: 'success', title: 'Codex upgraded' }),
        ),
      { timeout: 5000 },
    )
  }, 10000)

  it('shows an error surface when the daemon cannot be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('nope', { status: 500 })),
    )

    render(<HarnessesPanel baseUrl="http://127.0.0.1:4317" hosts={[]} onToast={vi.fn()} />)

    expect(await screen.findByText(/daemon returned 500/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})

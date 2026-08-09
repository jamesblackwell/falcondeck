import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentsPanel } from './AgentsPanel'

const emptyOverview = { providers: {}, resolved: [] }

describe('AgentsPanel recommended agents', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('configures Pi with the maintained ACP adapter command', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(emptyOverview), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            providers: { pi: { label: 'Pi', command: ['pi-acp'] } },
            resolved: [
              {
                id: 'pi',
                label: 'Pi',
                command: ['pi-acp'],
                binary_found: true,
                reserved: false,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    const onToast = vi.fn()

    render(<AgentsPanel baseUrl="http://127.0.0.1:4317" onToast={onToast} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Configure Pi' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    const [, request] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(request).toMatchObject({
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
    })
    expect(JSON.parse(request.body as string)).toEqual({
      providers: { pi: { label: 'Pi', command: ['pi-acp'] } },
    })
    expect(await screen.findByRole('button', { name: 'Configured' })).toBeDisabled()
    expect(onToast).toHaveBeenCalledWith({
      variant: 'success',
      title: 'Pi configured',
      description: 'FalconDeck will run pi-acp on this host.',
    })
  })

  it('shows the complete local install command before Pi is configured', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(emptyOverview), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

    render(<AgentsPanel baseUrl="http://127.0.0.1:4317" onToast={vi.fn()} />)

    expect(
      await screen.findByText(
        'npm install -g --ignore-scripts @earendil-works/pi-coding-agent pi-acp',
      ),
    ).toBeVisible()
  })
})

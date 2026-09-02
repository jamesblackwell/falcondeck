import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentsPanel } from './AgentsPanel'

const emptyOverview = { revision: 'revision-0', providers: {}, resolved: [] }

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
            revision: 'revision-1',
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
      expected_revision: 'revision-0',
    })
    expect(await screen.findByRole('button', { name: 'Configured' })).toBeDisabled()
    expect(onToast).toHaveBeenCalledWith({
      variant: 'success',
      title: 'Pi configured',
      description: 'FalconDeck will run pi-acp on this host.',
    })
  })

  it('configures Cursor with its built-in ACP command', async () => {
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
            revision: 'revision-1',
            providers: { cursor: { label: 'Cursor', command: ['cursor-agent', 'acp'] } },
            resolved: [
              {
                id: 'cursor',
                label: 'Cursor',
                command: ['cursor-agent', 'acp'],
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

    fireEvent.click(await screen.findByRole('button', { name: 'Configure Cursor' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    const [, request] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(JSON.parse(request.body as string)).toEqual({
      providers: { cursor: { label: 'Cursor', command: ['cursor-agent', 'acp'] } },
      expected_revision: 'revision-0',
    })
    expect(onToast).toHaveBeenCalledWith({
      variant: 'success',
      title: 'Cursor configured',
      description: 'FalconDeck will run cursor-agent acp on this host.',
    })
  })

  it('configures OpenCode with its built-in ACP command', async () => {
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
            revision: 'revision-1',
            providers: { opencode: { label: 'OpenCode', command: ['opencode', 'acp'] } },
            resolved: [
              {
                id: 'opencode',
                label: 'OpenCode',
                command: ['opencode', 'acp'],
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

    fireEvent.click(await screen.findByRole('button', { name: 'Configure OpenCode' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    const [, request] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(JSON.parse(request.body as string)).toEqual({
      providers: {
        opencode: { label: 'OpenCode', command: ['opencode', 'acp'], transport: 'auto' },
      },
      expected_revision: 'revision-0',
    })
    expect(onToast).toHaveBeenCalledWith({
      variant: 'success',
      title: 'OpenCode configured',
      description: 'FalconDeck will try OpenCode native and fall back to ACP on this host.',
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

  it('shows the official OpenCode install command before it is configured', async () => {
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
      await screen.findByText('curl -fsSL https://opencode.ai/install | bash'),
    ).toBeVisible()
  })

  it('switches OpenCode to ACP without discarding its command or environment', async () => {
    const configured = {
      revision: 'revision-5',
      providers: {
        opencode: {
          label: 'OpenCode custom',
          command: ['/opt/bin/opencode', 'acp'],
          env: { OPENCODE_CONFIG: '/tmp/opencode.json' },
          transport: 'auto',
        },
      },
      resolved: [
        {
          id: 'opencode',
          label: 'OpenCode custom',
          command: ['/opt/bin/opencode', 'acp'],
          binary_found: true,
          reserved: false,
        },
      ],
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(configured), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(configured), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)

    render(<AgentsPanel baseUrl="http://127.0.0.1:4317" onToast={vi.fn()} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Use ACP' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    const [, request] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(JSON.parse(request.body as string)).toEqual({
      providers: {
        opencode: {
          label: 'OpenCode custom',
          command: ['/opt/bin/opencode', 'acp'],
          env: { OPENCODE_CONFIG: '/tmp/opencode.json' },
          transport: 'acp',
        },
      },
      expected_revision: 'revision-5',
    })
  })

  it('reloads instead of overwriting a concurrent provider change', async () => {
    const latest = { ...emptyOverview, revision: 'revision-1' }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(emptyOverview), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response('providers changed since they were loaded', { status: 409 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(latest), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const onToast = vi.fn()

    render(<AgentsPanel baseUrl="http://127.0.0.1:4317" onToast={onToast} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Configure Pi' }))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3))
    expect(onToast).toHaveBeenCalledWith({
      variant: 'danger',
      title: 'Could not save agents',
      description:
        'Agents changed elsewhere while this panel was open. The latest list has been loaded; make the change again.',
    })
  })

  it.each(['codex', 'claude', 'agy', 'cursor', 'opencode', 'pi'])(
    'does not let the generic form shadow the %s integration',
    async (reservedId) => {
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
      fireEvent.click(await screen.findByRole('button', { name: 'Add agent' }))
      fireEvent.change(screen.getByLabelText('Agent id'), { target: { value: reservedId } })
      fireEvent.change(screen.getByLabelText('ACP command'), { target: { value: 'agent acp' } })
      expect(screen.getByRole('button', { name: 'Add agent' })).toBeDisabled()
    },
  )
})

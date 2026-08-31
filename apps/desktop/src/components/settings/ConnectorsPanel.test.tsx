import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConnectorsPanel, type ConnectorWorkspace } from './ConnectorsPanel'

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const emptyOverview = {
  global: {},
  workspace: null,
  merged: [],
}

function workspace(
  id: string,
  path: string,
  kind?: ConnectorWorkspace['kind'],
): ConnectorWorkspace {
  return { id, path, kind }
}

describe('ConnectorsPanel', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function renderPanel(workspaces: ConnectorWorkspace[]) {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(emptyOverview))
    vi.stubGlobal('fetch', fetchMock)
    render(
      <ConnectorsPanel
        baseUrl="http://127.0.0.1:4317"
        workspaces={workspaces}
        onToast={vi.fn()}
      />,
    )
    return fetchMock
  }

  it('lists global and project workspaces, not casual chats', async () => {
    renderPanel([
      workspace(
        'ws-chat',
        '/Users/dev/Documents/FalconDeck/2026-08-24/chat-120000-abcdef',
        'casual',
      ),
      workspace('ws-2', '/Users/dev/lucidpic', 'project'),
      workspace('ws-1', '/Users/dev/falcondeck', 'project'),
    ])

    const scopePicker = await screen.findByRole('combobox', { name: 'Configuration scope' })
    fireEvent.click(scopePicker)
    expect(screen.getByRole('option', { name: /Global/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /falcondeck/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: /lucidpic/ })).toBeInTheDocument()
    expect(screen.queryByRole('option', { name: /chat-120000/ })).not.toBeInTheDocument()
  })

  it('keeps project scopes in one compact selector', async () => {
    renderPanel([
      workspace('ws-2', '/Users/dev/lucidpic', 'project'),
      workspace('ws-1', '/Users/dev/falcondeck', 'project'),
    ])

    expect(
      await screen.findByRole('combobox', { name: 'Configuration scope' }),
    ).toHaveTextContent('Global')
    expect(screen.queryByRole('button', { name: 'falcondeck' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'lucidpic' })).not.toBeInTheDocument()
  })

  it('shows only one add surface at a time', async () => {
    renderPanel([])

    fireEvent.click(await screen.findByRole('button', { name: 'Paste JSON' }))
    expect(screen.getByText('Paste an MCP config')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Add server' }))
    expect(screen.queryByText('Paste an MCP config')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: 'Connector name' })).toBeInTheDocument()
  })

  it('hides the scope chips when every workspace is a casual chat', async () => {
    renderPanel([
      workspace(
        'ws-chat',
        '/Users/dev/Documents/FalconDeck/2026-08-24/chat-120000-abcdef',
        'casual',
      ),
    ])

    expect(await screen.findByText(/No MCP servers yet/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Global' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /chat-120000/ })).not.toBeInTheDocument()
  })

  it('treats a workspace with omitted kind as a project', async () => {
    renderPanel([workspace('ws-1', '/Users/dev/falcondeck')])
    fireEvent.click(await screen.findByRole('combobox', { name: 'Configuration scope' }))
    expect(screen.getByRole('option', { name: /falcondeck/ })).toBeInTheDocument()
  })

  it('loads workspace connectors when a project scope is selected', async () => {
    const fetchMock = renderPanel([workspace('ws-1', '/Users/dev/falcondeck', 'project')])
    fireEvent.click(await screen.findByRole('combobox', { name: 'Configuration scope' }))
    fireEvent.click(screen.getByRole('option', { name: /falcondeck/ }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4317/api/connectors?workspace_id=ws-1',
      )
    })
  })

  it('uses the standard switch to update a connector', async () => {
    const overview = {
      global: {
        sentry: { url: 'https://mcp.sentry.dev/mcp', enabled: true },
      },
      workspace: null,
      merged: [
        {
          name: 'sentry',
          scope: 'global' as const,
          url: 'https://mcp.sentry.dev/mcp',
          enabled: true,
        },
      ],
    }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(overview))
    vi.stubGlobal('fetch', fetchMock)
    render(
      <ConnectorsPanel
        baseUrl="http://127.0.0.1:4317"
        workspaces={[]}
        onToast={vi.fn()}
      />,
    )

    fireEvent.click(await screen.findByRole('switch', { name: 'Disable sentry' }))

    await waitFor(() => {
      const write = fetchMock.mock.calls.find(([, options]) => options?.method === 'PUT')
      expect(write).toBeDefined()
      expect(JSON.parse(String(write?.[1]?.body))).toEqual({
        scope: 'global',
        mcpServers: {
          sentry: { url: 'https://mcp.sentry.dev/mcp', enabled: false },
        },
      })
    })
  })
})

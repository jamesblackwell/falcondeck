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

    expect(await screen.findByRole('button', { name: 'Global' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'falcondeck' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'lucidpic' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /chat-120000/ })).not.toBeInTheDocument()
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
    expect(await screen.findByRole('button', { name: 'falcondeck' })).toBeInTheDocument()
  })

  it('loads workspace connectors when a project chip is selected', async () => {
    const fetchMock = renderPanel([workspace('ws-1', '/Users/dev/falcondeck', 'project')])
    fireEvent.click(await screen.findByRole('button', { name: 'falcondeck' }))
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        'http://127.0.0.1:4317/api/connectors?workspace_id=ws-1',
      )
    })
  })
})

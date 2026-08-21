import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PluginsView } from './PluginsView'

const LIBRARY = {
  root: '/home/user/.agents/skills',
  skills: [
    {
      name: 'grill-me',
      description: 'Relentless interviewing skill.',
      path: '/home/user/.agents/skills/grill-me',
      managed: true,
      source: 'mattpocock/skills',
      registryId: 'mattpocock/skills/grill-me',
      installedAt: '2026-08-21T00:00:00Z',
    },
    {
      name: 'hand-rolled',
      description: 'Placed on disk by hand.',
      path: '/home/user/.agents/skills/hand-rolled',
      managed: false,
      source: null,
      registryId: null,
      installedAt: null,
    },
  ],
}

const REGISTRY = {
  query: '',
  ranking: 'trending',
  skills: [
    {
      id: 'vercel-labs/skills/find-skills',
      skillId: 'find-skills',
      name: 'find-skills',
      source: 'vercel-labs/skills',
      installs: 3_000_000,
      installed: false,
    },
    {
      id: 'mattpocock/skills/grill-me',
      skillId: 'grill-me',
      name: 'grill-me',
      source: 'mattpocock/skills',
      installs: 925_012,
      installed: true,
    },
  ],
}

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/api/skills/registry')) {
      return new Response(JSON.stringify(REGISTRY), { status: 200 })
    }
    if (url.includes('/api/skills')) {
      return new Response(JSON.stringify(LIBRARY), { status: 200 })
    }
    if (url.includes('/api/connectors')) {
      return new Response(
        JSON.stringify({ global: {}, workspace: null, merged: [] }),
        { status: 200 },
      )
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('PluginsView', () => {
  it('lists installed skills and only offers removal for managed ones', async () => {
    stubFetch()
    render(
      <PluginsView baseUrl="http://127.0.0.1:4123" workspaces={[]} onToast={vi.fn()} />,
    )

    expect(await screen.findByText('/grill-me')).toBeInTheDocument()
    expect(screen.getByText('/hand-rolled')).toBeInTheDocument()
    expect(screen.getByLabelText('Remove /grill-me')).toBeInTheDocument()
    expect(screen.queryByLabelText('Remove /hand-rolled')).not.toBeInTheDocument()
  })

  it('shows trending registry results with install state', async () => {
    stubFetch()
    render(
      <PluginsView baseUrl="http://127.0.0.1:4123" workspaces={[]} onToast={vi.fn()} />,
    )

    expect(await screen.findByText('/find-skills')).toBeInTheDocument()
    expect(screen.getByText('Trending on skills.sh')).toBeInTheDocument()
    expect(screen.getByText('3.0M installs')).toBeInTheDocument()
    // The already-installed registry entry shows a badge, not an install
    // button — "Installed" appears as the section heading plus that badge.
    expect(screen.getAllByText('Installed')).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /Install/ })).toHaveLength(1)
  })

  it('installs a registry skill through the daemon', async () => {
    const fetchMock = stubFetch()
    const onToast = vi.fn()
    render(
      <PluginsView baseUrl="http://127.0.0.1:4123" workspaces={[]} onToast={onToast} />,
    )

    fireEvent.click(await screen.findByRole('button', { name: /Install/ }))
    await waitFor(() =>
      expect(onToast).toHaveBeenCalledWith(
        expect.objectContaining({ variant: 'success' }),
      ),
    )
    const installCall = fetchMock.mock.calls.find(([url]) =>
      String(url).includes('/api/skills/install'),
    )
    expect(installCall).toBeDefined()
    const [, init] = installCall as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({
      source: 'vercel-labs/skills',
      skill: 'find-skills',
    })
  })

  it('switches to the MCP servers section', async () => {
    stubFetch()
    render(
      <PluginsView baseUrl="http://127.0.0.1:4123" workspaces={[]} onToast={vi.fn()} />,
    )

    fireEvent.click(screen.getByRole('tab', { name: 'MCP servers' }))
    await waitFor(() =>
      expect(screen.queryByText('Trending on skills.sh')).not.toBeInTheDocument(),
    )
  })
})

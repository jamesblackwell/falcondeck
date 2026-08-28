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

const CATALOG = {
  servers: [
    {
      id: 'notion',
      name: 'Notion',
      description: 'Search and edit your Notion workspace.',
      category: 'Productivity',
      url: 'https://mcp.notion.com/mcp',
      auth: 'oauth',
      domain: 'notion.so',
      featured: true,
      installed: false,
      connected: false,
    },
    {
      id: 'fal-ai',
      name: 'fal',
      description: 'Generate images, video, and audio with fal models.',
      category: 'Creativity',
      url: 'https://mcp.fal.ai/mcp',
      auth: 'api_key',
      domain: 'fal.ai',
      featured: false,
      installed: false,
      connected: false,
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
    if (url.includes('/api/connectors/catalog')) {
      return new Response(JSON.stringify(CATALOG), { status: 200 })
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
  it('defaults to Plugins with a catalog and top-level Skills tab', async () => {
    stubFetch()
    render(
      <PluginsView baseUrl="http://127.0.0.1:4123" workspaces={[]} onToast={vi.fn()} />,
    )

    expect(screen.getByRole('tab', { name: 'Plugins' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(screen.getByRole('tab', { name: 'Skills' })).toHaveAttribute(
      'aria-selected',
      'false',
    )
    expect(await screen.findByRole('heading', { name: 'Plugins' })).toBeInTheDocument()
    expect(screen.getAllByText('Notion').length).toBeGreaterThan(0)
    expect(screen.getAllByRole('button', { name: 'Connect Notion' }).length).toBeGreaterThan(0)
    expect(screen.getByText('fal')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Featured' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Installed' })).toBeInTheDocument()
  })

  it('lists installed skills and only offers removal for managed ones', async () => {
    stubFetch()
    render(
      <PluginsView baseUrl="http://127.0.0.1:4123" workspaces={[]} onToast={vi.fn()} />,
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }))
    expect(screen.getByText('Loading installed skills…')).toBeInTheDocument()
    expect(await screen.findByText('/grill-me')).toBeInTheDocument()
    expect(screen.getByText('/hand-rolled')).toBeInTheDocument()
    expect(screen.getByLabelText('Remove /grill-me')).toBeInTheDocument()
    expect(screen.queryByLabelText('Remove /hand-rolled')).not.toBeInTheDocument()
  })

  it('shows trending registry results with install state on Skills', async () => {
    stubFetch()
    render(
      <PluginsView baseUrl="http://127.0.0.1:4123" workspaces={[]} onToast={vi.fn()} />,
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }))
    expect(await screen.findByText('/find-skills')).toBeInTheDocument()
    expect(screen.getByText('Trending on skills.sh')).toBeInTheDocument()
    expect(screen.getByText('3.0M installs')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Install/ })).toHaveLength(1)
  })

  it('installs a registry skill through the daemon', async () => {
    const fetchMock = stubFetch()
    const onToast = vi.fn()
    render(
      <PluginsView baseUrl="http://127.0.0.1:4123" workspaces={[]} onToast={onToast} />,
    )

    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }))
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

  it('refreshes Installed when an install finishes after switching views', async () => {
    let resolveInstall!: (response: Response) => void
    const installResponse = new Promise<Response>((resolve) => {
      resolveInstall = resolve
    })
    let libraryLoads = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/skills/install')) return installResponse
      if (url.includes('/api/skills/registry')) {
        return new Response(JSON.stringify(REGISTRY), { status: 200 })
      }
      if (url.endsWith('/api/skills')) {
        libraryLoads += 1
        return new Response(JSON.stringify(LIBRARY), { status: 200 })
      }
      if (url.includes('/api/connectors/catalog')) {
        return new Response(JSON.stringify(CATALOG), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <PluginsView baseUrl="http://127.0.0.1:4123" workspaces={[]} onToast={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }))
    await screen.findByText('/hand-rolled')
    fireEvent.click(await screen.findByRole('button', { name: /Install/ }))
    fireEvent.click(screen.getByRole('tab', { name: 'Plugins' }))
    await waitFor(() => expect(libraryLoads).toBeGreaterThanOrEqual(1))

    resolveInstall(new Response(null, { status: 200 }))

    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }))
    await waitFor(() => expect(libraryLoads).toBeGreaterThanOrEqual(2))
  })

  it('refreshes Browse when an uninstall finishes after switching views', async () => {
    let resolveUninstall!: (response: Response) => void
    const uninstallResponse = new Promise<Response>((resolve) => {
      resolveUninstall = resolve
    })
    let registryLoads = 0
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === 'DELETE') return uninstallResponse
      if (url.includes('/api/skills/registry')) {
        registryLoads += 1
        return new Response(JSON.stringify(REGISTRY), { status: 200 })
      }
      if (url.endsWith('/api/skills')) {
        return new Response(JSON.stringify(LIBRARY), { status: 200 })
      }
      if (url.includes('/api/connectors/catalog')) {
        return new Response(JSON.stringify(CATALOG), { status: 200 })
      }
      throw new Error(`unexpected fetch: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <PluginsView baseUrl="http://127.0.0.1:4123" workspaces={[]} onToast={vi.fn()} />,
    )
    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }))
    await screen.findByLabelText('Remove /grill-me')
    await screen.findByText('/find-skills')
    const loadsAfterOpen = registryLoads
    expect(loadsAfterOpen).toBeGreaterThanOrEqual(1)
    fireEvent.click(screen.getByLabelText('Remove /grill-me'))
    fireEvent.click(screen.getByRole('tab', { name: 'Plugins' }))

    resolveUninstall(new Response(null, { status: 200 }))

    fireEvent.click(screen.getByRole('tab', { name: 'Skills' }))
    await waitFor(() => expect(registryLoads).toBeGreaterThan(loadsAfterOpen))
  })

  it('opens the connectors manager from the plus control', async () => {
    stubFetch()
    render(
      <PluginsView baseUrl="http://127.0.0.1:4123" workspaces={[]} onToast={vi.fn()} />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add a custom MCP server' }))
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Connectors' })).toBeInTheDocument(),
    )
  })
})

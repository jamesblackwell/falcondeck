import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { TerminalSessionInfo } from '@falcondeck/client-core'

import { TerminalPanel } from './TerminalPanel'
import { nextActiveTabId, terminalTabLabel, type TerminalTab } from '../terminal-tabs'

vi.mock('./TerminalView', () => ({
  TerminalView: ({ session }: { session: TerminalSessionInfo }) => (
    <div data-testid="terminal-view" data-session={session.id} />
  ),
}))

const apiMocks = vi.hoisted(() => ({
  listTerminals: vi.fn(),
  openTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  terminalSocketUrl: vi.fn(
    (id: string) => `ws://127.0.0.1:4123/api/terminals/${id}/ws?since_seq=0`,
  ),
}))

vi.mock('@falcondeck/client-core', () => ({
  createDaemonApiClient: () => apiMocks,
}))

function session(id: string, overrides: Partial<TerminalSessionInfo> = {}): TerminalSessionInfo {
  return {
    id,
    workspace_id: 'workspace-1',
    shell: '/bin/zsh',
    title: 'zsh',
    cwd: '/projects/falcondeck',
    cols: 100,
    rows: 30,
    created_at: '2026-08-27T12:00:00Z',
    ...overrides,
  }
}

function tab(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return { session: session(id), status: 'running', observedTitle: null, ...overrides }
}

async function renderPanel(
  workspaceId: string | null = 'workspace-1',
  onHide: () => void = vi.fn(),
) {
  render(
    <TerminalPanel
      baseUrl="http://127.0.0.1:4123"
      workspaceId={workspaceId}
      onHide={onHide}
    />,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  apiMocks.listTerminals.mockResolvedValue({ sessions: [] })
  apiMocks.openTerminal.mockImplementation(async () => ({
    session: session('term-new'),
  }))
  apiMocks.closeTerminal.mockResolvedValue({ ok: true })
})

describe('TerminalPanel', () => {
  it('restores live daemon sessions as tabs with the newest active', async () => {
    apiMocks.listTerminals.mockResolvedValue({
      sessions: [session('term-1'), session('term-2')],
    })
    await renderPanel()
    expect(await screen.findByTestId('terminal-view')).toHaveAttribute('data-session', 'term-2')
    expect(document.querySelectorAll('[data-terminal-tab]')).toHaveLength(2)
    expect(apiMocks.openTerminal).not.toHaveBeenCalled()
  })

  it('auto-creates a terminal when the workspace has none', async () => {
    await renderPanel()
    await waitFor(() => {
      expect(apiMocks.openTerminal).toHaveBeenCalledWith('workspace-1', { cols: 100, rows: 30 })
    })
    expect(await screen.findByTestId('terminal-view')).toHaveAttribute('data-session', 'term-new')
  })

  it('starts a new terminal from the + button', async () => {
    apiMocks.listTerminals.mockResolvedValue({ sessions: [session('term-1')] })
    apiMocks.openTerminal.mockResolvedValue({ session: session('term-2') })
    await renderPanel()
    await screen.findByTestId('terminal-view')
    fireEvent.click(screen.getByLabelText('New terminal'))
    await waitFor(() => {
      expect(document.querySelectorAll('[data-terminal-tab]')).toHaveLength(2)
    })
    expect(apiMocks.openTerminal).toHaveBeenCalled()
    expect(screen.getByTestId('terminal-view')).toHaveAttribute('data-session', 'term-2')
  })

  it('closes a terminal through its tab button', async () => {
    apiMocks.listTerminals.mockResolvedValue({
      sessions: [session('term-1'), session('term-2')],
    })
    await renderPanel()
    await screen.findByTestId('terminal-view')
    const closeButton = document.querySelectorAll('[data-terminal-tab-close]')[0]
    fireEvent.click(closeButton)
    await waitFor(() => {
      expect(apiMocks.closeTerminal).toHaveBeenCalledWith('term-1')
    })
    expect(document.querySelectorAll('[data-terminal-tab]')).toHaveLength(1)
  })

  it('hides the panel without closing its terminal session', async () => {
    apiMocks.listTerminals.mockResolvedValue({ sessions: [session('term-1')] })
    const onHide = vi.fn()
    await renderPanel('workspace-1', onHide)
    await screen.findByTestId('terminal-view')

    fireEvent.click(screen.getByLabelText('Hide terminal'))

    expect(onHide).toHaveBeenCalledOnce()
    expect(apiMocks.closeTerminal).not.toHaveBeenCalled()
  })

  it('prompts for a project when no workspace is selected', async () => {
    await renderPanel(null)
    expect(screen.getByText(/Select a project/)).toBeInTheDocument()
    expect(apiMocks.listTerminals).not.toHaveBeenCalled()
    expect(screen.getByLabelText('New terminal')).toBeDisabled()
  })

  it('surfaces a load failure instead of an empty panel', async () => {
    apiMocks.listTerminals.mockRejectedValue(new Error('daemon offline'))
    await renderPanel()
    expect(await screen.findByText('Could not load terminals.')).toBeInTheDocument()
  })
})

describe('terminal tab helpers', () => {
  it('labels tabs with the observed program title over the shell name', () => {
    expect(terminalTabLabel(tab('a'))).toBe('zsh')
    expect(terminalTabLabel({ ...tab('a'), observedTitle: 'vim src/app.tsx' })).toBe('vim src/app.tsx')
  })

  it('selects the neighbouring tab when the active one closes', () => {
    const tabs = [tab('a'), tab('b'), tab('c')]
    expect(nextActiveTabId(tabs, 'b')).toBe('c')
    expect(nextActiveTabId(tabs, 'c')).toBe('b')
    expect(nextActiveTabId(tabs, 'a')).toBe('b')
    expect(nextActiveTabId([tab('a')], 'a')).toBeNull()
    expect(nextActiveTabId([], 'missing')).toBeNull()
  })
})

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ToastProvider } from '@falcondeck/ui'

import { DiffPanel, type DiffPanelSelection } from './DiffPanel'

const api = {
  gitStatus: vi.fn().mockResolvedValue({ branch: 'main', entries: [] }),
  gitDiff: vi.fn().mockResolvedValue({ diff: '', content: null }),
  workspaceFiles: vi.fn().mockResolvedValue({ files: [], truncated: false }),
  workspaceFile: vi.fn(),
  writeWorkspaceFile: vi.fn(),
}

function renderPanel(
  selection: DiffPanelSelection | null,
  threadId: string | null,
  onSelectionChange = vi.fn(),
) {
  return render(
    <ToastProvider>
      <DiffPanel
        api={api}
        workspaceId="workspace-1"
        threadId={threadId}
        refreshTrigger={0}
        selection={selection}
        onSelectionChange={onSelectionChange}
      />
    </ToastProvider>,
  )
}

describe('DiffPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps casual chat folders out of the git review surface', () => {
    render(
      <ToastProvider>
        <DiffPanel
          api={api}
          workspaceId="chat-workspace"
          refreshTrigger={0}
          selection={null}
          onSelectionChange={vi.fn()}
          info={{
            workspacePath: '/Users/James/Documents/FalconDeck/2026-08-25/chat-test',
            workspaceKind: 'casual',
            hostName: null,
            thread: null,
          }}
        />
      </ToastProvider>,
    )

    expect(screen.queryByRole('button', { name: /changes/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /files/i })).toBeInTheDocument()
    expect(api.gitStatus).not.toHaveBeenCalled()
  })

  it('closes an open preview when the selected thread changes', async () => {
    const onSelectionChange = vi.fn()
    const selection = { workspaceId: 'workspace-1', filePath: 'README.md', view: 'changes' as const }
    const view = renderPanel(selection, 'thread-1', onSelectionChange)

    view.rerender(
      <ToastProvider>
        <DiffPanel
          api={api}
          workspaceId="workspace-1"
          threadId="thread-2"
          refreshTrigger={0}
          selection={selection}
          onSelectionChange={onSelectionChange}
        />
      </ToastProvider>,
    )

    await waitFor(() => expect(onSelectionChange).toHaveBeenCalledWith(null))
  })

  it('returns to the file list from an open preview', async () => {
    const onSelectionChange = vi.fn()
    const selection = { workspaceId: 'workspace-1', filePath: 'README.md', view: 'changes' as const }
    renderPanel(selection, 'thread-1', onSelectionChange)

    fireEvent.click(screen.getByRole('button', { name: 'Back to changed files' }))

    await waitFor(() => expect(onSelectionChange).toHaveBeenCalledWith(null))
  })
})

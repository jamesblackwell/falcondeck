import { useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ToastProvider } from '@falcondeck/ui'

import { DiffPanel, type DiffPanelSelection } from './DiffPanel'

const api = {
  gitStatus: vi.fn().mockResolvedValue({ branch: 'main', entries: [] }),
  gitDiff: vi.fn().mockResolvedValue({ diff: '', content: null }),
  workspaceFiles: vi.fn().mockResolvedValue({ files: [], truncated: false }),
  workspaceFile: vi.fn().mockResolvedValue({
    path: 'README.md',
    content: '# Hello\n',
    is_binary: false,
    truncated: false,
    version: 'v1',
  }),
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
  it('restores folders, search, scroll and focus after previewing a file', async () => {
    api.workspaceFiles.mockResolvedValue({
      files: ['.agents/skills/drums/SKILL.md', 'README.md'],
      truncated: false,
    })
    api.workspaceFile.mockResolvedValue({
      path: '.agents/skills/drums/SKILL.md',
      content: '# Skill',
      is_binary: false,
      truncated: false,
      version: 'v1',
    })
    function Host() {
      const [selection, setSelection] = useState<DiffPanelSelection | null>(null)
      return (
        <ToastProvider>
          <DiffPanel
            api={api}
            workspaceId="workspace-1"
            threadId="thread-1"
            refreshTrigger={0}
            selection={selection}
            onSelectionChange={setSelection}
          />
        </ToastProvider>
      )
    }
    render(<Host />)
    fireEvent.click(screen.getByRole('button', { name: 'files' }))
    fireEvent.click(await screen.findByRole('treeitem', { name: '.agents' }))
    fireEvent.click(screen.getByRole('treeitem', { name: 'skills' }))
    fireEvent.click(screen.getByRole('treeitem', { name: 'drums' }))
    const fileRow = screen.getByRole('treeitem', { name: 'SKILL.md' })
    const scroller = screen.getByRole('tree').parentElement!
    scroller.scrollTop = 180
    fireEvent.scroll(scroller)
    act(() => fileRow.focus())
    fireEvent.click(fileRow)
    fireEvent.click(await screen.findByRole('button', { name: 'Back to files' }))
    expect(screen.getByRole('treeitem', { name: 'SKILL.md' })).toBeVisible()
    expect(scroller.scrollTop).toBe(180)
    expect(fileRow).toHaveFocus()

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'SKILL' },
    })
    fireEvent.click(screen.getByRole('treeitem', { name: 'SKILL.md' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Back to files' }))
    expect(screen.getByRole('textbox')).toHaveValue('SKILL')
    // Re-selecting the active tab should not erase a search either.
    fireEvent.click(screen.getByRole('button', { name: 'files' }))
    expect(screen.getByRole('textbox')).toHaveValue('SKILL')
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(screen.getByRole('textbox')).toHaveValue('')
    expect(screen.getByRole('treeitem', { name: 'SKILL.md' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'changes' }))
    fireEvent.click(screen.getByRole('button', { name: 'files' }))
    expect(await screen.findByRole('treeitem', { name: 'SKILL.md' })).toBeVisible()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    api.gitStatus.mockResolvedValue({ branch: 'main', entries: [] })
    api.workspaceFiles.mockResolvedValue({ files: [], truncated: false })
  })

  it('opens a linked folder in the files tree and expands its ancestors', async () => {
    api.workspaceFiles.mockResolvedValue({
      files: ['docs/marketing/submissions/acp/draft.md', 'README.md'],
      truncated: false,
    })
    api.workspaceFile.mockRejectedValueOnce(new Error('workspace path is not a file'))
    const onSelectionChange = vi.fn()
    renderPanel(
      { workspaceId: 'workspace-1', filePath: 'docs/marketing/submissions/', view: 'files' },
      'thread-1',
      onSelectionChange,
    )

    const folder = await screen.findByRole('treeitem', { name: 'submissions' })
    expect(folder.closest('[role="treeitem"]')).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('treeitem', { name: 'acp' })).toBeVisible()
    expect(screen.queryByText('workspace path is not a file')).toBeNull()
    expect(screen.getByRole('button', { name: 'files' })).toHaveAttribute('aria-pressed', 'true')

    // Folder expansion remains interactive after opening a link.
    fireEvent.click(folder)
    expect(screen.queryByRole('treeitem', { name: 'acp' })).toBeNull()
    fireEvent.click(folder)
    fireEvent.click(screen.getByRole('treeitem', { name: 'acp' }))
    fireEvent.click(screen.getByRole('treeitem', { name: 'draft.md' }))
    expect(onSelectionChange).toHaveBeenCalledWith({
      workspaceId: 'workspace-1', filePath: 'docs/marketing/submissions/acp/draft.md', view: 'files',
    })

    fireEvent.click(screen.getByRole('button', { name: 'changes' }))
    expect(onSelectionChange).toHaveBeenCalledWith(null)
  })

  it('keeps missing paths on the file error view', async () => {
    api.workspaceFile.mockRejectedValueOnce(new Error('workspace file not found'))
    renderPanel(
      { workspaceId: 'workspace-1', filePath: 'missing.md', view: 'files' },
      'thread-1',
    )
    expect(await screen.findByText('workspace file not found')).toBeVisible()
    expect(screen.queryByRole('tree')).toBeNull()
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

    fireEvent.click(await screen.findByRole('button', { name: 'Back to files' }))

    await waitFor(() => expect(onSelectionChange).toHaveBeenCalledWith(null))
  })

  it('shows an untracked markdown file instead of an empty diff', async () => {
    api.gitDiff.mockResolvedValue({ diff: '', content: null })
    api.workspaceFile.mockResolvedValue({
      path: 'docs/qa/notes.md',
      content: '# Audit\n\nPasses on mobile.',
      is_binary: false,
      truncated: false,
      version: 'v1',
    })
    renderPanel(
      { workspaceId: 'workspace-1', filePath: 'docs/qa/notes.md', view: 'changes' },
      'thread-1',
    )

    expect(await screen.findByRole('heading', { name: 'Audit' })).toBeVisible()
    expect(screen.getByRole('button', { name: 'Preview' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('Unable to load this file')).toBeNull()
    expect(screen.queryByText(/untracked/i)).toBeNull()
  })

  it('keeps a real unified diff on the diff viewer', async () => {
    api.gitDiff.mockResolvedValue({
      diff: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
      content: null,
    })
    renderPanel(
      { workspaceId: 'workspace-1', filePath: 'src/a.ts', view: 'changes' },
      'thread-1',
    )

    expect(await screen.findByRole('button', { name: 'Back to changed files' })).toBeVisible()
    expect(await screen.findByText('new')).toBeVisible()
    expect(screen.getByText('old')).toBeVisible()
  })

  it('steps from the ends of the change list when the open file has left it', async () => {
    const entries = [
      { path: 'a.ts', status: 'modified' as const, insertions: 1, deletions: 0 },
      { path: 'b.ts', status: 'modified' as const, insertions: 1, deletions: 0 },
      { path: 'c.ts', status: 'modified' as const, insertions: 1, deletions: 0 },
    ]
    api.gitStatus.mockResolvedValue({ branch: 'main', entries })
    api.gitDiff.mockResolvedValue({
      diff: 'diff --git a/gone.ts b/gone.ts\n--- a/gone.ts\n+++ b/gone.ts\n@@ -1 +1 @@\n-old\n+new\n',
      content: null,
    })
    const onSelectionChange = vi.fn()
    const { rerender } = renderPanel(
      { workspaceId: 'workspace-1', filePath: 'gone.ts', view: 'changes' },
      'thread-1',
      onSelectionChange,
    )

    await screen.findByRole('button', { name: 'Previous changed file' })
    await waitFor(() => {
      onSelectionChange.mockClear()
      fireEvent.click(screen.getByRole('button', { name: 'Previous changed file' }))
      expect(onSelectionChange).toHaveBeenLastCalledWith({
        workspaceId: 'workspace-1',
        filePath: 'c.ts',
        view: 'changes',
      })
    })
    onSelectionChange.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Next changed file' }))
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      workspaceId: 'workspace-1',
      filePath: 'a.ts',
      view: 'changes',
    })

    onSelectionChange.mockClear()
    rerender(
      <ToastProvider>
        <DiffPanel
          api={api}
          workspaceId="workspace-1"
          threadId="thread-1"
          refreshTrigger={0}
          selection={{ workspaceId: 'workspace-1', filePath: 'b.ts', view: 'changes' }}
          onSelectionChange={onSelectionChange}
        />
      </ToastProvider>,
    )
    fireEvent.click(await screen.findByRole('button', { name: 'Previous changed file' }))
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      workspaceId: 'workspace-1',
      filePath: 'a.ts',
      view: 'changes',
    })
    fireEvent.click(screen.getByRole('button', { name: 'Next changed file' }))
    expect(onSelectionChange).toHaveBeenLastCalledWith({
      workspaceId: 'workspace-1',
      filePath: 'c.ts',
      view: 'changes',
    })
  })

  it('ignores a stale workspace file read after switching files', async () => {
    let finishSlow:
      | ((file: {
          path: string
          content: string
          is_binary: boolean
          truncated: boolean
          version: string
        }) => void)
      | undefined
    const slow = new Promise<{
      path: string
      content: string
      is_binary: boolean
      truncated: boolean
      version: string
    }>((resolve) => {
      finishSlow = resolve
    })
    api.gitDiff.mockResolvedValue({ diff: '', content: null })
    api.workspaceFile.mockImplementation((_workspaceId: string, path: string) => {
      if (path === 'slow.md') return slow
      return Promise.resolve({
        path,
        content: '# Fast\n',
        is_binary: false,
        truncated: false,
        version: 'v1',
      })
    })
    const view = renderPanel(
      { workspaceId: 'workspace-1', filePath: 'slow.md', view: 'changes' },
      'thread-1',
    )
    view.rerender(
      <ToastProvider>
        <DiffPanel
          api={api}
          workspaceId="workspace-1"
          threadId="thread-1"
          refreshTrigger={0}
          selection={{ workspaceId: 'workspace-1', filePath: 'fast.md', view: 'changes' }}
          onSelectionChange={vi.fn()}
        />
      </ToastProvider>,
    )

    expect(await screen.findByRole('heading', { name: 'Fast' })).toBeVisible()
    finishSlow?.({
      path: 'slow.md',
      content: '# Slow\n',
      is_binary: false,
      truncated: false,
      version: 'v1',
    })
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Slow' })).toBeNull()
    })
    expect(screen.getByRole('heading', { name: 'Fast' })).toBeVisible()
  })
})

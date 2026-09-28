import { useState } from 'react'
import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { FileListView, type FileListViewProps } from './FileListView'

// The query is host state now, so tests need a host to type into.
function StatefulFileListView(props: Omit<FileListViewProps, 'query' | 'onQueryChange'>) {
  const [query, setQuery] = useState('')
  return <FileListView {...props} query={query} onQueryChange={setQuery} />
}

const entry = {
  path: 'src/App.tsx',
  status: 'modified' as const,
  insertions: 4,
  deletions: 1,
}

function renderView() {
  const onTabChange = vi.fn()
  const onSelectChangedFile = vi.fn()
  render(
    <StatefulFileListView
      entries={[entry]}
      files={['README.md', 'src/App.tsx', 'src/utils.ts']}
      filesTruncated={false}
      branch="main"
      activeTab="changes"
      isLoading={false}
      isFilesLoading={false}
      error={null}
      filesError={null}
      onTabChange={onTabChange}
      onRefresh={vi.fn()}
      onRefreshFiles={vi.fn()}
      onSelectChangedFile={onSelectChangedFile}
      onSelectWorkspaceFile={vi.fn()}
    />,
  )
  return { onTabChange, onSelectChangedFile }
}

function renderContextMenuView(options: {
  activeTab?: 'changes' | 'files'
  entries?: FileListViewProps['entries']
  localRoot?: string | null
  onLocalPath?: FileListViewProps['onLocalPath']
} = {}) {
  const onSelectChangedFile = vi.fn()
  const onSelectWorkspaceFile = vi.fn()
  render(
    <StatefulFileListView
      entries={options.entries ?? [entry]}
      files={['README.md', 'src/App.tsx']}
      filesTruncated={false}
      branch="main"
      activeTab={options.activeTab ?? 'files'}
      isLoading={false}
      isFilesLoading={false}
      error={null}
      filesError={null}
      onTabChange={vi.fn()}
      onRefresh={vi.fn()}
      onRefreshFiles={vi.fn()}
      onSelectChangedFile={onSelectChangedFile}
      onSelectWorkspaceFile={onSelectWorkspaceFile}
      localRoot={options.localRoot ?? null}
      onLocalPath={options.onLocalPath ?? null}
      editors={[{ id: 'zed', name: 'Zed' }]}
    />,
  )
  return { onSelectChangedFile, onSelectWorkspaceFile }
}

describe('FileListView', () => {
  it('opens a file from its context menu in the default app or a detected editor', () => {
    const onLocalPath = vi.fn()
    const { onSelectWorkspaceFile } = renderContextMenuView({
      localRoot: '/Users/me/project',
      onLocalPath,
    })
    const row = screen.getByRole('button', { name: 'README.md' })

    const contextMenu = createEvent.contextMenu(row)
    fireEvent(row, contextMenu)
    expect(contextMenu.defaultPrevented).toBe(true)
    expect(screen.getByRole('menuitem', { name: 'Copy Full Path' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Default App' }))
    expect(onLocalPath).toHaveBeenLastCalledWith('open', '/Users/me/project/README.md', undefined)

    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Zed' }))
    expect(onLocalPath).toHaveBeenLastCalledWith('open-with', '/Users/me/project/README.md', 'zed')

    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByRole('menuitem', { name: /Reveal in Finder|Show in Explorer|Show in folder/ }))
    expect(onLocalPath).toHaveBeenLastCalledWith('reveal', '/Users/me/project/README.md', undefined)

    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Preview File' }))
    expect(onSelectWorkspaceFile).toHaveBeenCalledWith('README.md')
  })

  it('opens a file in the macOS default text editor', () => {
    const userAgent = vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Macintosh')
    try {
      const onLocalPath = vi.fn()
      renderContextMenuView({ localRoot: '/Users/me/project', onLocalPath })

      fireEvent.contextMenu(screen.getByRole('button', { name: 'README.md' }))
      fireEvent.click(screen.getByRole('menuitem', { name: 'Open in Default Editor' }))
      expect(onLocalPath).toHaveBeenCalledWith(
        'open-default-editor',
        '/Users/me/project/README.md',
        undefined,
      )
    } finally {
      userAgent.mockRestore()
    }
  })

  it('offers Finder and editor actions for folders from the keyboard menu', () => {
    const onLocalPath = vi.fn()
    renderContextMenuView({ localRoot: '/Users/me/project', onLocalPath })
    const folder = screen.getByRole('button', { name: 'src' })

    fireEvent.keyDown(folder, { key: 'F10', shiftKey: true })
    expect(screen.queryByRole('menuitem', { name: 'Preview File' })).toBeNull()
    expect(screen.getByRole('menuitem', { name: 'Open in Zed' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('menuitem', { name: /Open in Finder|Open in Explorer|Open Folder/ }))
    expect(onLocalPath).toHaveBeenCalledWith('open', '/Users/me/project/src', undefined)
  })

  it('keeps deleted changes available for diff review without offering local open', () => {
    const onLocalPath = vi.fn()
    const deleted = { ...entry, status: 'deleted' as const }
    const { onSelectChangedFile } = renderContextMenuView({
      activeTab: 'changes',
      entries: [deleted],
      localRoot: '/Users/me/project',
      onLocalPath,
    })

    fireEvent.contextMenu(screen.getByRole('button', { name: /src\/App\.tsx/ }))
    expect(screen.queryByRole('menuitem', { name: 'Open in Default App' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Preview File' })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: 'View Changes' }))
    expect(onSelectChangedFile).toHaveBeenCalledWith(deleted)
    expect(onLocalPath).not.toHaveBeenCalled()
  })

  it('keeps preview and relative path actions for remote workspaces', () => {
    renderContextMenuView()
    fireEvent.contextMenu(screen.getByRole('button', { name: 'README.md' }))

    expect(screen.getByRole('menuitem', { name: 'Preview File' })).toBeInTheDocument()
    expect(screen.getByRole('menuitem', { name: 'Copy Relative Path' })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Open in Default App' })).toBeNull()
    expect(screen.queryByRole('menuitem', { name: 'Copy Full Path' })).toBeNull()
  })

  it('filters changed files without losing their diff totals', () => {
    const { onSelectChangedFile } = renderView()
    fireEvent.change(screen.getByRole('textbox', { name: 'Filter changes' }), {
      target: { value: 'App' },
    })
    const row = screen.getByRole('button', { name: /src\/App\.tsx.*\+4.*-1.*M/ })
    fireEvent.click(row)
    expect(onSelectChangedFile).toHaveBeenCalledWith(entry)
  })

  it('offers the overview tab only when the host supplies its context', () => {
    const { unmount } = render(
      <StatefulFileListView
        entries={[entry]}
        files={[]}
        filesTruncated={false}
        branch="main"
        activeTab="info"
        isLoading={false}
        isFilesLoading={false}
        error={null}
        filesError={null}
        onTabChange={vi.fn()}
        onRefresh={vi.fn()}
        onRefreshFiles={vi.fn()}
        onSelectChangedFile={vi.fn()}
        onSelectWorkspaceFile={vi.fn()}
        info={{ workspacePath: '/tmp/project', hostName: null, thread: null }}
      />,
    )
    expect(screen.getByRole('button', { name: 'info' })).toBeInTheDocument()
    expect(screen.getByText('/tmp/project')).toBeInTheDocument()
    // The overview has nothing to filter, so the field steps aside.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    unmount()

    renderView()
    expect(screen.queryByRole('button', { name: 'info' })).not.toBeInTheDocument()
  })

  it('says the listing is capped so a missing file is not read as absent', () => {
    render(
      <StatefulFileListView
        entries={[]}
        files={['README.md']}
        filesTruncated
        branch="main"
        activeTab="files"
        isLoading={false}
        isFilesLoading={false}
        error={null}
        filesError={null}
        onTabChange={vi.fn()}
        onRefresh={vi.fn()}
        onRefreshFiles={vi.fn()}
        onSelectChangedFile={vi.fn()}
        onSelectWorkspaceFile={vi.fn()}
      />,
    )
    expect(screen.getByText(/Showing the first 20,000 files/)).toBeInTheDocument()
  })

  it('waits for the daemon rather than calling a pending search empty', () => {
    const { rerender } = render(
      <FileListView
        entries={[]}
        files={['README.md']}
        filesTruncated={false}
        branch="main"
        activeTab="files"
        isLoading={false}
        isFilesLoading
        error={null}
        filesError={null}
        onTabChange={vi.fn()}
        onRefresh={vi.fn()}
        onRefreshFiles={vi.fn()}
        onSelectChangedFile={vi.fn()}
        onSelectWorkspaceFile={vi.fn()}
        query="audit"
        onQueryChange={vi.fn()}
      />,
    )
    // The stale listing has no match, but the search is still running.
    expect(screen.queryByText(/No files match/)).not.toBeInTheDocument()

    rerender(
      <FileListView
        entries={[]}
        files={[]}
        filesTruncated={false}
        branch="main"
        activeTab="files"
        isLoading={false}
        isFilesLoading={false}
        error={null}
        filesError={null}
        onTabChange={vi.fn()}
        onRefresh={vi.fn()}
        onRefreshFiles={vi.fn()}
        onSelectChangedFile={vi.fn()}
        onSelectWorkspaceFile={vi.fn()}
        query="audit"
        onQueryChange={vi.fn()}
      />,
    )
    expect(screen.getByText(/No files match/)).toBeInTheDocument()
  })

  it('switches to the file browser', () => {
    const { onTabChange } = renderView()
    fireEvent.click(screen.getByRole('button', { name: 'files' }))
    expect(onTabChange).toHaveBeenCalledWith('files')
  })
})

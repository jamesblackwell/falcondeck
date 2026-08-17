import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { FileListView } from './FileListView'

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
    <FileListView
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

describe('FileListView', () => {
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
      <FileListView
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

  it('switches to the file browser', () => {
    const { onTabChange } = renderView()
    fireEvent.click(screen.getByRole('button', { name: 'files' }))
    expect(onTabChange).toHaveBeenCalledWith('files')
  })
})

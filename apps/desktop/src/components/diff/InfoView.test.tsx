import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { GitStatusEntry, ThreadSummary } from '@falcondeck/client-core'

import { InfoView, type ReviewInfoContext } from './InfoView'

function entriesOf(count: number): GitStatusEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `src/file-${index}.ts`,
    status: 'modified' as const,
    insertions: 2,
    deletions: 1,
  }))
}

const thread = {
  id: 't1',
  variant: null,
  origin: null,
  handoff_from: null,
} as unknown as ThreadSummary

function renderInfo(overrides: Partial<ReviewInfoContext> = {}, count = 7) {
  const onSelectChangedFile = vi.fn()
  render(
    <InfoView
      info={{
        workspacePath: '/Users/James/www/sites/lucidpic',
        hostName: null,
        thread,
        ...overrides,
      }}
      entries={entriesOf(count)}
      branch="main"
      isLoading={false}
      error={null}
      onSelectChangedFile={onSelectChangedFile}
    />,
  )
  return { onSelectChangedFile }
}

describe('InfoView', () => {
  it('summarises the checkout and totals the uncommitted diff', () => {
    renderInfo()
    expect(screen.getByText('Local')).toBeInTheDocument()
    expect(screen.getByText('Project folder')).toBeInTheDocument()
    expect(screen.getByText('/Users/James/www/sites/lucidpic')).toBeInTheDocument()
    expect(screen.getByText('main')).toBeInTheDocument()
    expect(screen.getByText('Dirty')).toBeInTheDocument()
    expect(screen.getByText('7 files,')).toBeInTheDocument()
    expect(screen.getByText('+14')).toBeInTheDocument()
    expect(screen.getByText('-7')).toBeInTheDocument()
  })

  it('collapses the file list until expanded, and opens a file', () => {
    const { onSelectChangedFile } = renderInfo()
    expect(screen.queryByText('file-6.ts')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }))
    expect(screen.getByText('file-6.ts')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /src\/file-0\.ts/ }))
    expect(onSelectChangedFile).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'src/file-0.ts' }),
    )
  })

  it('shows the isolated checkout path and host instead of the project folder', () => {
    renderInfo({
      hostName: 'quizgecko-ops-2',
      hostConnected: true,
      thread: {
        ...thread,
        variant: {
          slug: 'fix-login',
          path: '/Users/James/.falcondeck/clones/fix-login',
          branch: 'fix-login',
          kind: 'clone',
        },
      } as ThreadSummary,
    })
    expect(screen.getByText('quizgecko-ops-2')).toBeInTheDocument()
    expect(screen.getByText('Isolated clone')).toBeInTheDocument()
    expect(
      screen.getByText('/Users/James/.falcondeck/clones/fix-login'),
    ).toBeInTheDocument()
  })

  it('reports a clean checkout with no file list', () => {
    renderInfo({}, 0)
    expect(screen.getByText('Clean')).toBeInTheDocument()
    expect(screen.queryByText(/Uncommitted/)).not.toBeInTheDocument()
  })
})

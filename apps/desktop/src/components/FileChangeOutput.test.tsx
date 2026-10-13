import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { FileDiffProvider, MessageCard } from '@falcondeck/chat-ui'
import type { ConversationItem } from '@falcondeck/client-core'

const PATCH = 'diff --git a/src/old.ts b/src/old.ts\n--- a/src/old.ts\n+++ b/src/old.ts\n@@ -1 +1 @@\n-old\n+new'

function fileChange(
  overrides: Partial<Extract<ConversationItem, { kind: 'file_change' }>> = {},
): Extract<ConversationItem, { kind: 'file_change' }> {
  return {
    kind: 'file_change',
    id: 'patch-1',
    changes: [{
      path: 'src/old.ts',
      change_kind: 'update',
      diff: PATCH,
      move_path: 'src/new.ts',
    }],
    status: 'completed',
    lifecycle: 'succeeded',
    created_at: '2026-08-09T10:00:00Z',
    completed_at: '2026-08-09T10:00:01Z',
    ...overrides,
  }
}

describe('structured file-change output', () => {
  it('summarizes terminal state and reveals paths, rename, and rendered diff', () => {
    render(<MessageCard item={fileChange()} />)
    const disclosure = screen.getByRole('button', { name: 'Renamed new.ts, Completed' })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('+1')).toBeVisible()
    expect(screen.getByText('−1')).toBeVisible()
    fireEvent.click(disclosure)
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    // A lone file opens straight onto its diff; the header names it.
    expect(screen.queryByRole('button', { name: 'src/new.ts, Renamed' })).toBeNull()
    expect(screen.getByText('from src/old.ts')).toBeVisible()
    expect(screen.getByText('new')).toBeVisible()
    expect(screen.getByText('old')).toBeVisible()
  })

  it('lists several files collapsed with workspace-relative paths', () => {
    render(
      <FileDiffProvider onOpenFile={vi.fn()} workspaceRoot="/Users/me/repo">
        <MessageCard
          item={fileChange({
            changes: [
              { path: '/Users/me/repo/docs/a.md', change_kind: 'add', diff: '--- /dev/null\n+++ b/docs/a.md\n@@ -0,0 +1,2 @@\n+one\n+two', move_path: null },
              { path: '/Users/me/repo/src/b.ts', change_kind: 'update', diff: PATCH, move_path: null },
            ],
          })}
        />
      </FileDiffProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: '2 files changed, Completed' }))
    expect(screen.getByText('+3')).toBeVisible()
    const added = screen.getByRole('button', { name: 'docs/a.md, Added' })
    expect(added).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText('docs')).toBeVisible()
    expect(screen.queryByText('two')).toBeNull()
    fireEvent.click(added)
    expect(screen.getByText('two')).toBeVisible()
  })

  it('keeps an announced patch visible before its first change arrives', () => {
    render(<MessageCard item={fileChange({ changes: [], status: 'inProgress', lifecycle: 'running' })} />)
    expect(screen.getByLabelText('Preparing file changes…, Running')).toBeDisabled()
  })

  it('opens the current destination path for a renamed file', () => {
    const onOpenFile = vi.fn()
    render(
      <FileDiffProvider onOpenFile={onOpenFile}>
        <MessageCard item={fileChange()} />
      </FileDiffProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Renamed new.ts, Completed' }))

    fireEvent.click(screen.getByRole('button', { name: 'Open src/new.ts in the changes panel' }))

    expect(onOpenFile).toHaveBeenCalledWith('src/new.ts')
    expect(screen.queryByTitle('Open src/old.ts in the changes panel')).toBeNull()
  })
})

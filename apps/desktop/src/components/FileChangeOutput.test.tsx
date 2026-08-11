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
    const disclosure = screen.getByRole('button', { name: 'Renamed old.ts, Completed' })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(disclosure)
    expect(disclosure).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByText('src/old.ts')).toHaveLength(1)
    expect(screen.getByText('→')).toBeVisible()
    expect(screen.getAllByText('src/new.ts')).toHaveLength(2)
    expect(screen.getByText('new')).toBeVisible()
    expect(screen.getByText('old')).toBeVisible()
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
    fireEvent.click(screen.getByRole('button', { name: 'Renamed old.ts, Completed' }))

    const destinationLinks = screen.getAllByTitle('Open src/new.ts in the changes panel')
    expect(destinationLinks).toHaveLength(2)
    fireEvent.click(destinationLinks[0]!)

    expect(onOpenFile).toHaveBeenCalledWith('src/new.ts')
    expect(screen.queryByTitle('Open src/old.ts in the changes panel')).toBeNull()
  })
})

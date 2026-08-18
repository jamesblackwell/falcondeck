import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { MergeFailureDialog, describeMergeFailure } from './merge-failure-dialog'

const UNTRACKED_ERROR = `error: The following untracked working tree files would be overwritten by merge:
  tests/Fixtures/generation-failures/README.md
  tests/Fixtures/lms/canvas-getmarked-request.json
Please move or remove them before you merge.
Aborting
Merge with strategy ort failed.`

describe('MergeFailureDialog', () => {
  it('explains an untracked-file blocker without flooding the viewport', () => {
    render(
      <MergeFailureDialog
        message={UNTRACKED_ERROR}
        branch="falcondeck/89070c86"
        baseBranch="main"
        onDismiss={vi.fn()}
      />,
    )

    expect(
      screen.getByRole('dialog', { name: 'main contains files that would be overwritten' }),
    ).toBeTruthy()
    expect(screen.getByText(/Nothing was merged or pushed\./)).toBeTruthy()
    expect(screen.getByText('2 files')).toBeTruthy()
    expect(screen.getByText('tests/Fixtures/generation-failures/README.md')).toBeTruthy()
    expect(screen.getByText('tests/Fixtures/lms/canvas-getmarked-request.json')).toBeTruthy()
  })

  it('dismisses from the close action', () => {
    const onDismiss = vi.fn()
    render(
      <MergeFailureDialog
        message={UNTRACKED_ERROR}
        branch="falcondeck/89070c86"
        baseBranch="main"
        onDismiss={onDismiss}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('does not claim that an unknown failure left the project untouched', () => {
    const result = describeMergeFailure('fatal: an unexpected git failure', 'main')

    expect(result.stoppedBeforeMerge).toBe(false)
    expect(result.title).toBe('FalconDeck could not complete the merge')
  })
})

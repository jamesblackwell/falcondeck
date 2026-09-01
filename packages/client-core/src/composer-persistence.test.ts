import { describe, expect, it } from 'vitest'

import {
  mergeFailedComposerAttachments,
  mergeFailedComposerDraft,
  mergeGuidedComposerDraft,
  updateAttachmentPreparationCount,
} from './composer-persistence'

describe('attachment preparation lifecycle', () => {
  it('counts overlapping batches independently per conversation and prunes settled keys', () => {
    const first = updateAttachmentPreparationCount({}, 'workspace:thread-a', 2)
    const overlapping = updateAttachmentPreparationCount(
      first,
      'workspace:thread-a',
      1,
    )
    const otherConversation = updateAttachmentPreparationCount(
      overlapping,
      'workspace:thread-b',
      4,
    )
    const firstSettled = updateAttachmentPreparationCount(
      otherConversation,
      'workspace:thread-a',
      -3,
    )

    expect(firstSettled).toEqual({ 'workspace:thread-b': 4 })
    expect(
      updateAttachmentPreparationCount(firstSettled, 'workspace:thread-b', -4),
    ).toEqual({})
  })
})

describe('failed composer submission recovery', () => {
  it('preserves newer text instead of overwriting it', () => {
    expect(mergeFailedComposerDraft('Failed message', '')).toBe(
      'Failed message',
    )
    expect(mergeFailedComposerDraft('', 'New draft')).toBe('New draft')
    expect(mergeFailedComposerDraft('Same draft', 'Same draft')).toBe(
      'Same draft',
    )
    expect(mergeFailedComposerDraft('Failed message', 'New draft')).toBe(
      'Failed message\n\nNew draft',
    )
  })

  it('preserves attachment order, newer additions, and current metadata', () => {
    const failed = [
      { id: 'one', name: 'old one' },
      { id: 'two', name: 'two' },
    ]
    const current = [
      { id: 'one', name: 'updated one' },
      { id: 'three', name: 'three' },
    ]

    expect(mergeFailedComposerAttachments(failed, current)).toEqual([
      { id: 'one', name: 'updated one' },
      { id: 'two', name: 'two' },
      { id: 'three', name: 'three' },
    ])
    expect(mergeFailedComposerAttachments([], current)).toEqual(current)
    expect(mergeFailedComposerAttachments(failed, [])).toEqual(failed)
  })
})

describe('guided composer drafts', () => {
  it('starts with the guide and preserves existing notes', () => {
    expect(mergeGuidedComposerDraft('Set this up', '')).toBe('Set this up')
    expect(mergeGuidedComposerDraft('Set this up', 'Keep this')).toBe(
      'Set this up\n\nCurrent notes:\nKeep this',
    )
  })

  it('does not duplicate a guide that is already present', () => {
    const current = 'Set this up\n\nCurrent notes:\nKeep this'
    expect(mergeGuidedComposerDraft('Set this up', current)).toBe(current)
  })
})

import { describe, expect, it } from 'vitest'

import {
  REASONING_PREVIEW_LINES,
  reasoningHeaderLabel,
  resolveReasoningReveal,
} from './reasoning'

describe('resolveReasoningReveal', () => {
  it('starts collapsed with no body under auto', () => {
    expect(resolveReasoningReveal('auto')).toEqual({ defaultOpen: false, collapsedLines: 0 })
  })

  it('starts collapsed with no body under always_collapsed', () => {
    expect(resolveReasoningReveal('always_collapsed')).toEqual({
      defaultOpen: false,
      collapsedLines: 0,
    })
  })

  it('opens under always_expanded', () => {
    expect(resolveReasoningReveal('always_expanded')).toEqual({
      defaultOpen: true,
      collapsedLines: 0,
    })
  })

  it('caps the body instead of hiding it under preview', () => {
    expect(resolveReasoningReveal('preview')).toEqual({
      defaultOpen: false,
      collapsedLines: REASONING_PREVIEW_LINES,
    })
  })
})

describe('reasoningHeaderLabel', () => {
  it('falls back when the provider sent no summary', () => {
    expect(reasoningHeaderLabel(null)).toBe('Thought process')
  })

  it('falls back when the summary is blank', () => {
    expect(reasoningHeaderLabel('   \n  \n')).toBe('Thought process')
  })

  it('uses the summary when there is one', () => {
    expect(reasoningHeaderLabel('Checking the test fixtures')).toBe('Checking the test fixtures')
  })

  it('takes the first non-empty line of a multi-line summary', () => {
    expect(reasoningHeaderLabel('\n  Planning the refactor  \nThen editing files')).toBe(
      'Planning the refactor',
    )
  })
})

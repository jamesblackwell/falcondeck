import { describe, expect, it } from 'vitest'

import { webSearchActionLabel } from './web-search'

describe('web search action presentation', () => {
  it('uses active wording while a page is opening', () => {
    expect(webSearchActionLabel('open_page', true)).toBe('Opening page')
  })

  it('retains a future provider action instead of collapsing it', () => {
    expect(webSearchActionLabel('capturePage', false)).toBe('Capture page')
  })
})

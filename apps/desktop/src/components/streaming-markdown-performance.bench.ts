import { bench, describe } from 'vitest'

import { splitStreamingMarkdownBlocks } from '@falcondeck/chat-ui'

const fencedResponse = [
  'Before.\n\n```ts',
  ...Array.from({ length: 2_000 }, (_, index) => `const value${index} = ${index}`),
  '```\n\nAfter',
].join('\n')

describe('streaming Markdown block splitting', () => {
  bench('splits a 2,000-line fenced response', () => {
    splitStreamingMarkdownBlocks(fencedResponse)
  })
})

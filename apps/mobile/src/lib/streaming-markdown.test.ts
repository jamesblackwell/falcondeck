import { describe, expect, it, vi } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { createStreamingMarkdownParser } from './streaming-markdown'

const processor = unified().use(remarkParse).use(remarkGfm)

describe('streaming Markdown parser', () => {
  it('reuses completed blocks and parses only the growing final block', () => {
    const parse = vi.fn((text: string) => processor.parse(text))
    const incremental = createStreamingMarkdownParser(parse)
    const prefix = 'A completed **paragraph**.\n\n'.repeat(80)
    const first = incremental(prefix + 'Tail', true)
    const second = incremental(prefix + 'Tail grows', true)
    expect(parse.mock.calls[1][0]).toBe('Tail grows')
    expect(second.children[0]).toBe(first.children[0])
    expect(second).toEqual(processor.parse(prefix + 'Tail grows'))
  })

  it.each([
    'Paragraph\n\nSecond paragraph\nsetext heading\n---\n\nTail',
    'Paragraph\n\n- one\n\n  two\n- three\n\nTail',
    'Paragraph\n\n> quote\n>\n> next\n\nTail',
    'Paragraph\n\n    indented code\n    more code\n\nTail',
    'Paragraph\n\n```ts\nconst x = 1\n\nmore\n```\n\nTail',
    'Paragraph\n\n| a | b |\n|---|---|\n| c | d |\n\nTail',
    'Paragraph\n\n<div>\nhtml\n\nmore\n</div>\n\nTail',
    '[source][id]\n\nTail\n\n[id]: https://example.com',
    'A footnote[^one]\n\nTail\n\n[^one]: Footnote text',
    'Paragraph\n\n  [multi\nline]: https://example.com\n\nTail',
    'Paragraph\n\n***\n\nTail with *emphasis* and [link](https://example.com)',
  ])('matches the full AST through every character of %s', text => {
    const incremental = createStreamingMarkdownParser((value: string) => processor.parse(value))
    for (let index = 1; index <= text.length; index++) {
      const prefix = text.slice(0, index)
      expect(incremental(prefix, true)).toEqual(processor.parse(prefix))
    }
    expect(incremental(text, false)).toEqual(processor.parse(text))
  })

  it('fully reparses replacements and completion', () => {
    const parse = vi.fn((text: string) => processor.parse(text))
    const incremental = createStreamingMarkdownParser(parse)
    incremental('First\n\nTail', true)
    expect(incremental('Other\n\nTail', true)).toEqual(processor.parse('Other\n\nTail'))
    incremental('Other\n\nTail final', false)
    expect(parse.mock.calls.at(-1)?.[0]).toBe('Other\n\nTail final')
  })
})

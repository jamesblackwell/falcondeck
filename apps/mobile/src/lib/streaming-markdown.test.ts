import { describe, expect, it, vi } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { createStreamingMarkdownParser } from './streaming-markdown'

const processor = unified().use(remarkParse).use(remarkGfm)

describe('streaming Markdown parser', () => {
  it('does not reparse an unchanged open fence body for each append', () => {
    let parsedCharacters = 0
    const incremental = createStreamingMarkdownParser((text: string) => {
      parsedCharacters += text.length
      return processor.parse(text)
    })
    let text = 'Intro.\n\n```ts\n' + 'const answer = 42; // completed code\n'.repeat(1000)
    incremental(text, true)
    parsedCharacters = 0
    for (let index = 0; index < 100; index++) {
      text += ' appended'
      incremental(text, true)
    }
    expect(parsedCharacters).toBeLessThan(2000)
    expect(incremental(text, true)).toEqual(processor.parse(text))
  })

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
    '> foo\n***\n\nTail',
    '1. a\n\n  2. b\n\n   3. c\n',
    '    code\n\n   more code\n\nTail',
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
    'Intro.\n\n```ts title="file.ts"\nconst x = 1\n\n😀\t日本語\n```\n\nAfter',
    '````js\n```\nbody\n````\nAfter',
    '~~~lang&amp; meta\\*\n  text\n~\n~~\n~~~x\n~~~\nAfter',
    '```\nline\n   ```  \nAfter',
    '```\nline\n    ```\nstill code\n```\nAfter',
    '```\nline\n\t```\nstill code\n```\nAfter',
    '```\n\n\nline\n\n',
    '```\nline\n```no closer\nbody\n```\n~~~\nnext\n~~~',
    '```ts\r\nline\r\n\r\n😀\r\n```\r\nAfter',
    '~~~\rline\r~~~\rAfter',
    '  ```ts\n  line\n line\n\tline\n  ```\nAfter',
    '> ```ts\n> code\n> ```\n\nAfter',
    '- ```ts\n  code\n  ```\n\nAfter',
    '```\nline\u0000\nbody\n```\nAfter',
    '<div>\n```ts\nbody\n```\n</div>',
    '[id]: https://example.com\n\n```\nbody\n```\n\n[id]',
    '```\n![file](https://example.com/a)\n<falcondeck_action name="x">\n```\nAfter',
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

  it('does not mutate the previous AST while appending code', () => {
    const incremental = createStreamingMarkdownParser((text: string) => processor.parse(text))
    const text = 'Intro.\n\n```ts\nconst answer = 42\n'
    const first = incremental(text, true)
    const original = structuredClone(first)
    const next = incremental(text + '😀\n\nnext', true)
    expect(first).toEqual(original)
    expect(next.children[0]).toBe(first.children[0])
    expect(next.children.at(-1)).not.toBe(first.children.at(-1))
    expect(next).toEqual(processor.parse(text + '😀\n\nnext'))
  })

  it('fully reparses a fence closer and anything following it in the same chunk', () => {
    const parse = vi.fn((text: string) => processor.parse(text))
    const incremental = createStreamingMarkdownParser(parse)
    const prefix = '```ts\nconst answer = 42\n'
    incremental(prefix, true)
    const complete = prefix + '```\n\n- after\n- fence'
    expect(incremental(complete, true)).toEqual(processor.parse(complete))
    expect(parse.mock.calls.at(-1)?.[0]).toBe(complete)
    expect(incremental(complete + '\n\nDone.', false)).toEqual(processor.parse(complete + '\n\nDone.'))
  })

  it('falls back when a replacement changes an open fence body', () => {
    const parse = vi.fn((text: string) => processor.parse(text))
    const incremental = createStreamingMarkdownParser(parse)
    incremental('```ts\nold body', true)
    expect(incremental('```ts\nnew body', true)).toEqual(processor.parse('```ts\nnew body'))
    expect(parse.mock.calls.at(-1)?.[0]).toBe('```ts\nnew body')
  })
})

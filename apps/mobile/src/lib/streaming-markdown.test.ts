import { describe, expect, it, vi } from 'vitest'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import { createStreamingMarkdownParser } from './streaming-markdown'

const processor = unified().use(remarkParse).use(remarkGfm)

describe('streaming Markdown parser', () => {
  it('parses only the growing final item of a large top-level list', () => {
    let parsedCharacters = 0
    const incremental = createStreamingMarkdownParser((text: string) => {
      parsedCharacters += text.length
      return processor.parse(text)
    })
    let text = Array.from({ length: 1000 }, (_, index) =>
      `- item ${index} describing a completed change in the source code\n`).join('')
    const first = incremental(text, true)
    parsedCharacters = 0
    for (let index = 0; index < 100; index++) {
      text += ' appended'
      incremental(text, true)
    }
    const last = incremental(text, true)
    expect(parsedCharacters).toBeLessThan(100000)
    if (first.children[0].type !== 'list' || last.children[0].type !== 'list') throw new Error('expected list')
    expect(last.children[0].children[0]).toBe(first.children[0].children[0])
    expect(last).toEqual(processor.parse(text))
  })

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
    '- first\n- second\nlast lazy continuation\nwith **bold** and 😀\n- third',
    'Intro.\n\n- first\n- second\n\n  next paragraph\n\n- third\n\nAfter',
    '- first\n\n- second\n\n  next paragraph\n\n- third',
    '- first\n- second\n\n\n- third\n\n\nAfter',
    '- first\n- second\n- - -\nAfter',
    '- first\n- second\n* * *\nAfter',
    '- first\n- second\n---\nAfter',
    '- first\n- second\n  ---\n\n- third',
    '- first\n- second\n+ next list\n+ fourth\n* fifth\n- sixth',
    '* first\n* second\n*\n**\n***\nAfter',
    '+ first\n+ second\n+\n+ third',
    '- first\n- [ ] task\n- [x] done\n- [X] done\n- [oops] text',
    '9. first\n10. second\n11. [ ] task\n12. last\n1) next list\n2) other',
    '2) first\n3) second\n\n4) next\n5. other delimiter\n6. last',
    '- first\n- second\n  - nested\n    1. ordered\n  - more\n- third',
    '- first\n- second\n\n  > quote\n  > lazy\n\n- third',
    '- first\n- second\n\n  ```ts\n  const value = 1\n  ```\n\n- third',
    '- first\n- second\n\n      indented code\n\n- third',
    '- first\n- second\n\n<div>\nhtml\n</div>\n\n- third',
    '- first\n- second\n  <div>\n  html\n  </div>\n\n- third',
    '- first\n- second\n  | a | b |\n  |---|---|\n  | c | d |\n- third',
    '- first\n- second with [label][id]\n\n[id]: https://example.com\n\nAfter',
    '- first\n- second\n\n  [label\n  id]: https://example.com\n\n- [id]',
    '- first\r\n- second\r\n\r\n- third\r\nAfter',
    '- first\r- second\r\r  lazy\r- third',
    '-\tfirst\n-\tsecond\n\tlazy\n- third',
    '  - first\n  - second\n  - third\n\nAfter',
    '> - first\n> - second\n>   continuation\n> - third\n\nAfter',
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

  it('preserves settled list items and ordered metadata without mutating previous ASTs', () => {
    const incremental = createStreamingMarkdownParser((text: string) => processor.parse(text))
    const text = '8. first\n\n9. second\n10. growing'
    const first = incremental(text, true)
    const original = structuredClone(first)
    const next = incremental(text + ' **item**\n\n11. next', true)
    expect(first).toEqual(original)
    if (first.children[0].type !== 'list' || next.children[0].type !== 'list') throw new Error('expected list')
    expect(next.children[0].start).toBe(8)
    expect(next.children[0].spread).toBe(true)
    expect(next.children[0].children[0]).toBe(first.children[0].children[0])
    expect(next).toEqual(processor.parse(text + ' **item**\n\n11. next'))
  })

  it('distinguishes spread inside the dirty item from blank lines between items', () => {
    const incremental = createStreamingMarkdownParser((text: string) => processor.parse(text))
    const text = '- first\n- second\n\n'
    incremental(text, true)
    const within = incremental(text + '  next paragraph', true)
    if (within.children[0].type !== 'list') throw new Error('expected list')
    expect(within.children[0].spread).toBe(false)
    expect(within.children[0].children[1].spread).toBe(true)
    expect(within).toEqual(processor.parse(text + '  next paragraph'))
    const between = incremental(text + '- next item', true)
    if (between.children[0].type !== 'list') throw new Error('expected list')
    expect(between.children[0].spread).toBe(true)
    expect(between).toEqual(processor.parse(text + '- next item'))
  })

  it('matches canonical list ASTs across deterministic randomized chunk boundaries', () => {
    const fixtures = [
      'Intro.\n\n' + Array.from({ length: 18 }, (_, index) =>
        `${index + 8}. [${index % 3 === 0 ? 'x' : ' '}] Item **${index}** with 😀 and [a](https://example.com)\n`).join('') + '\nAfter',
      '- first\n\n- second\n  lazy continuation\n\n- third\n\n  > quote\n  > next\n\n- fourth\n* different list\n* final\n',
      '+ first\n+ second\n\n  ~~~js\n  const value = "😀"\n  ~~~\n\n+ third\n\n    - nested\n      continued\n\n+ fourth\n\n<div>\nhtml\n</div>',
      '- first\n- second\n- - -\n\n- new\n- list\n\n  second paragraph\n\n- final\n\n[id]: https://example.com\n\n[id]',
    ]
    let state = 0x12345678
    for (const text of fixtures) {
      for (let attempt = 0; attempt < 8; attempt++) {
        const incremental = createStreamingMarkdownParser((value: string) => processor.parse(value))
        let length = 0
        while (length < text.length) {
          state = (Math.imul(state, 1664525) + 1013904223) >>> 0
          length = Math.min(text.length, length + 1 + state % 37)
          const prefix = text.slice(0, length)
          expect(incremental(prefix, true)).toEqual(processor.parse(prefix))
        }
        expect(incremental(text, false)).toEqual(processor.parse(text))
      }
    }
  })
})

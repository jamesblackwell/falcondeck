import React from 'react'
import { Linking, View } from 'react-native'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { cleanup, renderComponent, textOf } from '@/test/render'

import {
  buildMarkdownDefinitions,
  MarkdownRenderer,
  normalizeMarkdownForStreaming,
  renderMarkdownBlocks,
} from './MarkdownRenderer'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('normalizeMarkdownForStreaming', () => {
  it('closes a trailing inline link destination during streaming', () => {
    expect(normalizeMarkdownForStreaming('[OpenAI](https://openai.com')).toBe(
      '[OpenAI](https://openai.com)',
    )
  })

  it('leaves plain text, complete links, and empty destinations alone', () => {
    expect(normalizeMarkdownForStreaming('plain text')).toBe('plain text')
    expect(normalizeMarkdownForStreaming('](https://openai.com')).toBe('](https://openai.com')
    expect(normalizeMarkdownForStreaming('[OpenAI](https://openai.com)')).toBe(
      '[OpenAI](https://openai.com)',
    )
    expect(normalizeMarkdownForStreaming('[OpenAI](')).toBe('[OpenAI](')
    expect(normalizeMarkdownForStreaming('[OpenAI]( https://openai.com')).toBe(
      '[OpenAI]( https://openai.com',
    )
  })
})

describe('buildMarkdownDefinitions', () => {
  it('collects markdown definitions keyed by identifier', () => {
    expect(
      buildMarkdownDefinitions({
        type: 'root',
        children: [
          {
            type: 'definition',
            identifier: 'Docs',
            title: 'Reference',
            url: 'https://falcondeck.com/docs',
          },
        ],
      }),
    ).toEqual({
      docs: {
        title: 'Reference',
        url: 'https://falcondeck.com/docs',
      },
    })
  })
})

describe('MarkdownRenderer', () => {
  it('renders rich markdown blocks and inline styles', () => {
    const renderer = renderComponent(
      <MarkdownRenderer
        text={[
          '# Heading',
          '## Section',
          '### Subsection',
          '#### Detail',
          '',
          'Paragraph with **strong**, *emphasis*, ~~strike~~, `inline`, [docs](https://falcondeck.com), [ref link][fd], [Missing][missing], ![direct](https://example.com/direct.png), ![logo][img], and a hard break  ',
          'next line with inline <kbd>cmd</kbd>.',
          '',
          '1. First step',
          '- Bullet',
          '- [x] Done',
          '- [ ] Pending',
          '',
          '> Quoted text',
          '',
          '---',
          '',
          '```ts',
          'const value = 1',
          '```',
          '',
          '| Name | Value |',
          '| --- | --- |',
          '| foo |',
          '',
          '<div>raw html</div>',
          '',
          '[^1]',
          '',
          '[fd]: https://falcondeck.com/docs',
          '[img]: https://example.com/logo.png',
          '[^1]: Footnote body',
        ].join('\n')}
      />,
    )

    const renderedText = textOf(renderer)
    expect(renderedText).toContain('Heading')
    expect(renderedText).toContain('Section')
    expect(renderedText).toContain('Subsection')
    expect(renderedText).toContain('Detail')
    expect(renderedText).toContain('strong')
    expect(renderedText).toContain('emphasis')
    expect(renderedText).toContain('strike')
    expect(renderedText).toContain('inline')
    expect(renderedText).toContain('docs')
    expect(renderedText).toContain('ref link')
    expect(renderedText).toContain('Missing')
    expect(renderedText).toContain('[Image: direct]')
    expect(renderedText).toContain('[Image: logo]')
    expect(renderedText).toContain('next line')
    expect(renderedText).toContain('First step')
    expect(renderedText).toContain('Bullet')
    expect(renderedText).toContain('Done')
    expect(renderedText).toContain('Pending')
    expect(renderedText).toContain('Quoted text')
    expect(renderedText).toContain('Copy')
    expect(renderedText).toContain('Name')
    expect(renderedText).toContain('foo')
    expect(renderedText).toContain('<div>raw html</div>')
    expect(renderedText).toContain('[1]')
    expect(renderedText).toContain('Footnote body')
  })

  it('renders streamed partial markdown cleanly', () => {
    const codeBlock = renderComponent(<MarkdownRenderer text={'```ts\nconst value = 1'} />)
    const partialLink = renderComponent(
      <MarkdownRenderer text={'Read [OpenAI](https://openai.com'} />,
    )

    expect(textOf(codeBlock)).toContain('Copy')
    expect(textOf(codeBlock)).toContain('const value = 1')
    expect(textOf(partialLink)).toContain('OpenAI')
    expect(textOf(partialLink)).not.toContain('[OpenAI](')
  })

  it('opens only safe markdown links', () => {
    const openUrl = vi.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
    const safe = renderComponent(
      <MarkdownRenderer
        text={[
          '[Safe](https://falcondeck.com)',
          '[Ref][docs]',
          '![Direct](https://example.com/direct.png)',
          '![Ref image][img]',
          '',
          '[docs]: https://falcondeck.com/docs',
          '[img]: https://example.com/ref.png',
        ].join('\n')}
      />,
    )
    const unsafe = renderComponent(<MarkdownRenderer text="[Unsafe](javascript:alert(1))" />)

    safe.root
      .findAll((node) => typeof node.props?.onPress === 'function')
      .forEach((node) => {
        act(() => {
          node.props.onPress()
        })
      })

    expect(openUrl).toHaveBeenCalledWith('https://falcondeck.com')
    expect(openUrl).toHaveBeenCalledWith('https://falcondeck.com/docs')
    expect(openUrl).toHaveBeenCalledWith('https://example.com/direct.png')
    expect(openUrl).toHaveBeenCalledWith('https://example.com/ref.png')
    expect(
      unsafe.root.findAll((node) => typeof node.props?.onPress === 'function'),
    ).toHaveLength(0)
  })

  it('falls back for unsupported block and inline nodes', () => {
    const renderer = renderComponent(
      <View>
        {renderMarkdownBlocks(undefined, {})}
        {renderMarkdownBlocks(
          [
            { type: 'code' },
            {
              type: 'paragraph',
              children: [
                { type: 'inlineCode' },
                { type: 'text', value: ' ' },
                { type: 'link', url: 'https://example.com' },
                { type: 'text', value: ' ' },
                {
                  type: 'linkReference',
                  children: [{ type: 'text', value: 'No identifier' }],
                },
                { type: 'text', value: ' ' },
                { type: 'linkReference', label: 'Label fallback' },
                { type: 'text', value: ' ' },
                { type: 'linkReference', identifier: 'idOnly' },
              ],
            },
            {
              type: 'list',
              ordered: true,
              start: null,
              children: [
                {
                  type: 'listItem',
                  children: [
                    {
                      type: 'paragraph',
                      children: [{ type: 'text', value: 'Ordered fallback' }],
                    },
                  ],
                },
              ],
            },
            {
              type: 'footnoteDefinition',
              identifier: 'custom',
              children: [
                {
                  type: 'paragraph',
                  children: [{ type: 'text', value: 'Identifier footnote' }],
                },
              ],
            },
            {
              type: 'footnoteDefinition',
              children: [
                {
                  type: 'paragraph',
                  children: [{ type: 'text', value: 'Anonymous footnote' }],
                },
              ],
            },
            {
              type: 'table',
              children: [{ type: 'tableRow' }],
            },
            { type: 'table' },
            { type: 'html' },
            { type: 'list' },
            { type: 'mysteryValue', value: 'Raw fallback value' },
            {
              type: 'mysteryBlock',
              children: [
                {
                  type: 'paragraph',
                  children: [
                    {
                      type: 'mysteryInline',
                      children: [{ type: 'text', value: 'Fallback text' }],
                    },
                  ],
                },
              ],
            },
          ],
          {},
        )}
        {renderMarkdownBlocks(
          [
            {
              type: 'paragraph',
              children: [
                { type: 'link' },
                { type: 'text', value: ' ' },
                { type: 'linkReference' },
                { type: 'text', value: ' ' },
                { type: 'imageReference', identifier: 'imgOnly' },
                { type: 'text', value: ' ' },
                { type: 'imageReference' },
              ],
            },
          ],
          {
            imgonly: { url: 'https://example.com/only.png' },
          },
        )}
      </View>,
    )

    expect(textOf(renderer)).toContain('No identifier')
    expect(textOf(renderer)).toContain('https://example.com')
    expect(textOf(renderer)).toContain('Label fallback')
    expect(textOf(renderer)).toContain('idOnly')
    expect(textOf(renderer)).toContain('Ordered fallback')
    expect(textOf(renderer)).toContain('[custom]')
    expect(textOf(renderer)).toContain('[]')
    expect(textOf(renderer)).toContain('Identifier footnote')
    expect(textOf(renderer)).toContain('Anonymous footnote')
    expect(textOf(renderer)).toContain('Copy')
    expect(textOf(renderer)).toContain('Raw fallback value')
    expect(textOf(renderer)).toContain('Fallback text')
    expect(textOf(renderer)).toContain('https://example.com/only.png')
  })
})

import { memo, useDeferredValue, useMemo, type ReactNode } from 'react'
import { Linking, ScrollView, View } from 'react-native'
import { StyleSheet } from 'react-native-unistyles'
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

import { Text } from '@/components/ui'
import { CodeBlock } from './CodeBlock'

interface MarkdownRendererProps {
  text: string
}

type MarkdownNode = {
  type: string
  alt?: string | null
  checked?: boolean | null
  children?: MarkdownNode[]
  depth?: number
  identifier?: string
  label?: string | null
  lang?: string | null
  ordered?: boolean
  start?: number | null
  title?: string | null
  url?: string
  value?: string
}

type MarkdownRoot = {
  type: 'root'
  children: MarkdownNode[]
}

type MarkdownDefinitions = Record<string, { title?: string | null; url: string }>

const markdownProcessor = unified().use(remarkParse).use(remarkGfm)

export function normalizeMarkdownForStreaming(text: string): string {
  const normalized = text.replace(/\r\n?/g, '\n')
  const linkOpenerIndex = normalized.lastIndexOf('](')

  if (linkOpenerIndex === -1 || normalized.includes(')', linkOpenerIndex + 2)) {
    return normalized
  }

  const labelStartIndex = normalized.lastIndexOf('[', linkOpenerIndex)
  const destination = normalized.slice(linkOpenerIndex + 2)

  if (labelStartIndex === -1 || destination.length === 0 || /^\s/.test(destination)) {
    return normalized
  }

  return `${normalized})`
}

function parseMarkdown(text: string): MarkdownRoot {
  return markdownProcessor.parse(normalizeMarkdownForStreaming(text)) as MarkdownRoot
}

export function buildMarkdownDefinitions(root: MarkdownRoot): MarkdownDefinitions {
  return root.children.reduce<MarkdownDefinitions>((definitions, node) => {
    if (node.type === 'definition' && node.identifier && node.url) {
      definitions[node.identifier.toLowerCase()] = {
        title: node.title ?? null,
        url: node.url,
      }
    }

    return definitions
  }, {})
}

function resolveMarkdownDefinition(
  definitions: MarkdownDefinitions,
  identifier: string | undefined,
) {
  if (!identifier) {
    return null
  }

  return definitions[identifier.toLowerCase()] ?? null
}

function safeMarkdownUrl(url: string | undefined) {
  if (!url) {
    return null
  }

  return /^(https?:|mailto:|tel:)/i.test(url) ? url : null
}

function openMarkdownUrl(url: string) {
  void Linking.openURL(url)
}

function headingStyle(depth: number | undefined) {
  switch (depth) {
    case 1:
      return styles.heading1
    case 2:
      return styles.heading2
    case 3:
      return styles.heading3
    default:
      return styles.heading4
  }
}

function listMarker(node: MarkdownNode, index: number) {
  if (node.checked === true) {
    return '☑'
  }

  if (node.checked === false) {
    return '☐'
  }

  if (node.ordered) {
    return `${(node.start ?? 1) + index}.`
  }

  return '•'
}

function renderMarkdownInlineNodes(
  nodes: MarkdownNode[] | undefined,
  definitions: MarkdownDefinitions,
  keyPrefix: string,
): ReactNode[] {
  return (nodes ?? []).map((node, index) =>
    renderMarkdownInlineNode(node, definitions, `${keyPrefix}-inline-${index}`),
  )
}

function renderMarkdownInlineNode(
  node: MarkdownNode,
  definitions: MarkdownDefinitions,
  key: string,
): ReactNode {
  switch (node.type) {
    case 'break':
      return '\n'
    case 'delete':
      return (
        <Text key={key} style={styles.inlineDelete}>
          {renderMarkdownInlineNodes(node.children, definitions, key)}
        </Text>
      )
    case 'emphasis':
      return (
        <Text key={key} style={styles.inlineEmphasis}>
          {renderMarkdownInlineNodes(node.children, definitions, key)}
        </Text>
      )
    case 'footnoteReference':
      return (
        <Text key={key} color="tertiary" style={styles.footnoteReference}>
          [{node.label ?? node.identifier ?? ''}]
        </Text>
      )
    case 'html':
    case 'text':
      return node.value ?? ''
    case 'image': {
      const url = safeMarkdownUrl(node.url)

      return (
        <Text
          key={key}
          color={url ? 'accent' : 'secondary'}
          style={url ? styles.link : styles.imageFallback}
          onPress={url ? () => openMarkdownUrl(url) : undefined}
        >
          {node.alt ? `[Image: ${node.alt}]` : node.url ?? ''}
        </Text>
      )
    }
    case 'imageReference': {
      const definition = resolveMarkdownDefinition(definitions, node.identifier)
      const url = safeMarkdownUrl(definition?.url)

      return (
        <Text
          key={key}
          color={url ? 'accent' : 'secondary'}
          style={url ? styles.link : styles.imageFallback}
          onPress={url ? () => openMarkdownUrl(url) : undefined}
        >
          {node.alt ? `[Image: ${node.alt}]` : definition?.url ?? ''}
        </Text>
      )
    }
    case 'inlineCode':
      return (
        <Text key={key} variant="mono" color="secondary" style={styles.inlineCode}>
          {node.value ?? ''}
        </Text>
      )
    case 'link': {
      const url = safeMarkdownUrl(node.url)
      const children = renderMarkdownInlineNodes(node.children, definitions, key)

      return (
        <Text
          key={key}
          color={url ? 'accent' : 'primary'}
          style={url ? styles.link : undefined}
          onPress={url ? () => openMarkdownUrl(url) : undefined}
        >
          {children.length > 0 ? children : node.url ?? ''}
        </Text>
      )
    }
    case 'linkReference': {
      const definition = resolveMarkdownDefinition(definitions, node.identifier)
      const url = safeMarkdownUrl(definition?.url)
      const children = renderMarkdownInlineNodes(node.children, definitions, key)

      return (
        <Text
          key={key}
          color={url ? 'accent' : 'primary'}
          style={url ? styles.link : undefined}
          onPress={url ? () => openMarkdownUrl(url) : undefined}
        >
          {children.length > 0
            ? children
            : node.label ?? node.identifier ?? definition?.url ?? ''}
        </Text>
      )
    }
    case 'strong':
      return (
        <Text key={key} weight="semibold">
          {renderMarkdownInlineNodes(node.children, definitions, key)}
        </Text>
      )
    default:
      return renderMarkdownInlineNodes(node.children, definitions, key)
  }
}

function renderMarkdownTable(
  node: MarkdownNode,
  definitions: MarkdownDefinitions,
  key: string,
) {
  const rows = node.children ?? []
  const columnCount = rows.reduce(
    (count, row) => Math.max(count, row.children?.length ?? 0),
    0,
  )

  if (rows.length === 0 || columnCount === 0) {
    return null
  }

  return (
    <ScrollView key={key} horizontal showsHorizontalScrollIndicator={false}>
      <View style={styles.table}>
        {rows.map((row, rowIndex) => (
          <View key={`${key}-row-${rowIndex}`} style={styles.tableRow}>
            {Array.from({ length: columnCount }, (_, columnIndex) => {
              const cell = row.children?.[columnIndex]
              const isHeader = rowIndex === 0
              const isLastColumn = columnIndex === columnCount - 1
              const isLastRow = rowIndex === rows.length - 1

              return (
                <View
                  key={`${key}-cell-${rowIndex}-${columnIndex}`}
                  style={[
                    styles.tableCell,
                    isHeader ? styles.tableHeaderCell : undefined,
                    isLastColumn ? styles.tableCellLastColumn : undefined,
                    isLastRow ? styles.tableCellLastRow : undefined,
                  ]}
                >
                  <Text
                    style={[
                      styles.tableCellText,
                      isHeader ? styles.tableHeaderText : undefined,
                    ]}
                  >
                    {cell
                      ? renderMarkdownInlineNodes(
                          cell.children,
                          definitions,
                          `${key}-cell-${rowIndex}-${columnIndex}`,
                        )
                      : ''}
                  </Text>
                </View>
              )
            })}
          </View>
        ))}
      </View>
    </ScrollView>
  )
}

export function renderMarkdownBlocks(
  nodes: MarkdownNode[] | undefined,
  definitions: MarkdownDefinitions,
  keyPrefix = 'markdown',
): ReactNode[] {
  return (nodes ?? []).map((node, index) =>
    renderMarkdownBlock(node, definitions, `${keyPrefix}-block-${index}`),
  )
}

function renderMarkdownBlock(
  node: MarkdownNode,
  definitions: MarkdownDefinitions,
  key: string,
): ReactNode {
  switch (node.type) {
    case 'blockquote':
      return (
        <View key={key} style={styles.blockquote}>
          <View style={styles.blockquoteContent}>
            {renderMarkdownBlocks(node.children, definitions, key)}
          </View>
        </View>
      )
    case 'code':
      return <CodeBlock key={key} code={node.value ?? ''} language={node.lang ?? undefined} />
    case 'definition':
      return null
    case 'footnoteDefinition':
      return (
        <View key={key} style={styles.footnote}>
          <Text variant="caption" color="tertiary" size="xs" style={styles.footnoteLabel}>
            [{node.label ?? node.identifier ?? ''}]
          </Text>
          {renderMarkdownBlocks(node.children, definitions, key)}
        </View>
      )
    case 'heading':
      return (
        <Text key={key} weight="semibold" style={[styles.paragraph, headingStyle(node.depth)]}>
          {renderMarkdownInlineNodes(node.children, definitions, key)}
        </Text>
      )
    case 'html':
      return node.value ? (
        <Text key={key} color="secondary" style={styles.paragraph}>
          {node.value}
        </Text>
      ) : null
    case 'list':
      return node.children?.length ? (
        <View key={key} style={styles.list}>
          {node.children.map((child, index) => (
            <View key={`${key}-item-${index}`} style={styles.listItem}>
              <Text weight="semibold" style={styles.listMarker}>
                {listMarker({ ...child, ordered: node.ordered, start: node.start }, index)}
              </Text>
              <View style={styles.listItemBody}>
                {renderMarkdownBlocks(child.children, definitions, `${key}-item-${index}`)}
              </View>
            </View>
          ))}
        </View>
      ) : null
    case 'paragraph':
      return (
        <Text key={key} color="primary" style={styles.paragraph}>
          {renderMarkdownInlineNodes(node.children, definitions, key)}
        </Text>
      )
    case 'table':
      return renderMarkdownTable(node, definitions, key)
    case 'thematicBreak':
      return <View key={key} style={styles.rule} />
    default:
      return node.value ? (
        <Text key={key} color="primary" style={styles.paragraph}>
          {node.value}
        </Text>
      ) : (
        <View key={key}>{renderMarkdownBlocks(node.children, definitions, key)}</View>
      )
  }
}

export const MarkdownRenderer = memo(
  function MarkdownRenderer({ text }: MarkdownRendererProps) {
    const deferredText = useDeferredValue(text)
    const markdownTree = useMemo(() => parseMarkdown(deferredText), [deferredText])
    const definitions = useMemo(
      () => buildMarkdownDefinitions(markdownTree),
      [markdownTree],
    )
    const renderedBlocks = useMemo(
      () => renderMarkdownBlocks(markdownTree.children, definitions),
      [definitions, markdownTree],
    )

    return <View style={styles.container}>{renderedBlocks}</View>
  },
  (prev, next) => prev.text === next.text,
)

const styles = StyleSheet.create((theme) => ({
  container: {
    gap: theme.spacing[3],
  },
  paragraph: {
    lineHeight: theme.fontSize.base * theme.lineHeight.normal,
  },
  heading1: {
    fontSize: theme.fontSize['3xl'],
    lineHeight: 34,
  },
  heading2: {
    fontSize: theme.fontSize['2xl'],
    lineHeight: 30,
  },
  heading3: {
    fontSize: theme.fontSize.xl,
    lineHeight: 26,
  },
  heading4: {
    fontSize: theme.fontSize.lg,
    lineHeight: 24,
  },
  inlineCode: {
    backgroundColor: theme.colors.surface[3],
    borderRadius: theme.radius.sm,
    overflow: 'hidden',
    paddingHorizontal: theme.spacing[1.5],
    paddingVertical: theme.spacing[0.5],
  },
  inlineDelete: {
    textDecorationLine: 'line-through',
  },
  inlineEmphasis: {
    fontStyle: 'italic',
  },
  imageFallback: {
    fontStyle: 'italic',
  },
  link: {
    textDecorationLine: 'underline',
  },
  blockquote: {
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border.emphasis,
    paddingLeft: theme.spacing[3],
  },
  blockquoteContent: {
    gap: theme.spacing[2],
  },
  list: {
    gap: theme.spacing[2],
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing[2],
  },
  listItemBody: {
    flex: 1,
    gap: theme.spacing[2],
  },
  listMarker: {
    lineHeight: theme.fontSize.base * theme.lineHeight.normal,
    minWidth: 24,
  },
  rule: {
    backgroundColor: theme.colors.border.default,
    height: 1,
  },
  table: {
    borderColor: theme.colors.border.default,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    overflow: 'hidden',
  },
  tableRow: {
    flexDirection: 'row',
  },
  tableCell: {
    borderBottomColor: theme.colors.border.default,
    borderBottomWidth: 1,
    borderRightColor: theme.colors.border.default,
    borderRightWidth: 1,
    minWidth: 120,
    paddingHorizontal: theme.spacing[3],
    paddingVertical: 10,
  },
  tableCellText: {
    lineHeight: 22,
  },
  tableHeaderCell: {
    backgroundColor: theme.colors.surface[1],
  },
  tableCellLastColumn: {
    borderRightWidth: 0,
  },
  tableCellLastRow: {
    borderBottomWidth: 0,
  },
  tableHeaderText: {
    fontWeight: '600',
  },
  footnote: {
    borderTopColor: theme.colors.border.default,
    borderTopWidth: 1,
    gap: theme.spacing[2],
    paddingTop: theme.spacing[2],
  },
  footnoteLabel: {
    textTransform: 'uppercase',
  },
  footnoteReference: {
    fontSize: theme.fontSize.xs,
    lineHeight: 16,
  },
}))

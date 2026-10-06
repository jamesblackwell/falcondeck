type Point = { line: number; column: number; offset?: number }
type PositionedNode = {
  type?: string
  value?: string
  ordered?: boolean | null
  start?: number | null
  spread?: boolean | null
  position?: { start: Point; end: Point }
  children?: PositionedNode[]
}

type OpenFence = { contentStart: number; closer: RegExp }
type ListTail = { start: Point & { offset: number }; prefixSpread: boolean }

function listTail(text: string, root: PositionedNode): ListTail | null {
  const list = root.children?.at(-1)
  const items = list?.children
  const start = items?.at(-1)?.position?.start
  // A fresh marker at column one is independent of earlier simple items.
  // Keep container and indentation context with the full parser, and do not
  // freeze a partial/empty marker that can still turn into a thematic break.
  if (list?.type !== 'list' || list.position?.start.column !== 1 || !root.position ||
      !items || items.length < 2 || start?.column !== 1 || start.offset == null ||
      !/^(?:[*+-]|\d{1,9}[.)])[ \t]+\S/.test(text.slice(start.offset)) ||
      !root.children?.slice(0, -1).every(node =>
        node.type === 'paragraph' || node.type === 'heading' || node.type === 'thematicBreak')) return null
  // List spread measures blank lines between items, not spread within an
  // item. Only boundaries before the dirty item are retained; its spread and
  // any new boundaries must come from the new canonical tail.
  let prefixSpread = false
  let previousEndLine: number | null = null
  for (const item of items) {
    const position = item.position
    if (item.type !== 'listItem' || position?.start.column !== 1 ||
        item.children?.length !== 1 || item.children[0].type !== 'paragraph') return null
    prefixSpread ||= previousEndLine !== null && position.start.line > previousEndLine + 1
    previousEndLine = position.end.line
  }
  return { start: { ...start, offset: start.offset }, prefixSpread }
}

function shiftPositions(node: PositionedNode, start: Point & { offset: number }) {
  if (node.position) {
    for (const point of [node.position.start, node.position.end]) {
      if (point.offset != null) point.offset += start.offset
      point.line += start.line - 1
    }
  }
  node.children?.forEach(child => shiftPositions(child, start))
}

function openFence(text: string, root: PositionedNode): OpenFence | null {
  const code = root.children?.at(-1)
  const start = code?.position?.start
  // Only a top-level, unindented fence has literal body text. Containers,
  // indentation, CRLF and NUL preprocessing remain the canonical parser's job.
  if (code?.type !== 'code' || typeof code.value !== 'string' ||
      start?.column !== 1 || start.offset == null ||
      code.position?.end.offset !== text.length || !root.position || /[\r\0]/.test(text)) return null
  const opening = /^(`{3,}|~{3,})[^\n]*\n/.exec(text.slice(start.offset))
  if (!opening) return null
  const contentStart = start.offset + opening[0].length
  const closer = new RegExp(`(?:^|\\n) {0,3}${opening[1][0]}{${opening[1].length},}[\\t ]*(?=\\n|$)`)
  if (closer.test(text.slice(contentStart))) return null
  return { contentStart, closer }
}

/** Reuse settled prose/list items and append literal text to an open fence. */
export function createStreamingMarkdownParser<
  Node extends PositionedNode,
  Root extends PositionedNode & { children: Node[] },
>(parse: (text: string) => Root) {
  let previous: { text: string; root: Root } | null = null
  let fence: OpenFence | null = null
  let list: ListTail | null = null
  return (text: string, streaming: boolean): Root => {
    // Reference/footnote definitions can change earlier inline nodes. Final
    // messages and replacements always use the canonical full parser too.
    if (!streaming || text.includes(']:')) {
      previous = null
      fence = null
      list = null
      return parse(text)
    }
    if (previous?.text === text) return previous.root
    const last = previous?.root.children.at(-1)
    const start = last?.position?.start
    const offset = start?.offset == null ? 0 : start.offset - start.column + 1
    const appending = previous !== null && text.startsWith(previous.text)
    let root: Root
    const appended = previous && appending ? text.slice(previous.text.length) : ''
    const dirtyLine = previous && appending ? previous.text.slice(previous.text.lastIndexOf('\n') + 1) : ''
    if (previous && appending && fence && last?.position && previous.root.position && typeof last.value === 'string' &&
        !/[\r\0]/.test(appended) && !fence.closer.test(dirtyLine + appended)) {
      // The full parser established the fence and decoded its info string.
      // Restore the body newline it trims at EOF, append only the new literal
      // text, then trim the new EOF newline. A possible closer reparses fully.
      const restoredNewline = previous.text.length > fence.contentStart && previous.text.endsWith('\n')
        ? '\n' : ''
      const value = (last.value + restoredNewline + appended).replace(/\n$/, '')
      const end = { ...last.position.end }
      for (let index = 0; index < appended.length; index++) {
        if (appended[index] === '\n') {
          end.line++
          end.column = 1
        } else {
          end.column++
        }
      }
      end.offset = text.length
      root = {
        ...previous.root,
        position: { start: { ...previous.root.position.start }, end: { ...end } },
        children: [...previous.root.children.slice(0, -1), {
          ...last, value, position: { start: { ...last.position.start }, end },
        }],
      }
    } else if (previous && appending && list && last?.children && last.position && previous.root.position) {
      const tail = parse(text.slice(list.start.offset))
      const tailList = tail.children[0]
      // Reparse the whole document if the dirty marker changed ownership.
      // In particular, partial '-'/'*' sequences can become thematic breaks.
      if (tail.position && tailList?.type === 'list' && tailList.position?.start.offset === 0 &&
          tailList.children?.[0]?.position?.start.offset === 0 && tailList.ordered === last.ordered) {
        shiftPositions(tail, list.start)
        const merged = {
          ...tailList,
          start: last.start,
          spread: list.prefixSpread || tailList.spread,
          position: { start: { ...last.position.start }, end: { ...tailList.position.end } },
          children: [...last.children.slice(0, -1), ...tailList.children],
        }
        root = {
          ...tail,
          position: { start: { ...previous.root.position.start }, end: { ...tail.position.end } },
          children: [...previous.root.children.slice(0, -1), merged, ...tail.children.slice(1)],
        }
      } else {
        root = parse(text)
      }
      fence = openFence(text, root)
    } else if (previous && appending && start && offset > 0 &&
        last?.type === 'paragraph' && /\n[ \t]*\n$/.test(previous.text.slice(0, offset)) &&
        previous.root.children.every(node =>
          node.type === 'paragraph' || node.type === 'heading' || node.type === 'thematicBreak')) {
      // Start at the beginning of the line, preserving indentation for code,
      // lists and quotes. Container/marker blocks can change ownership when a
      // partial marker grows, even across blank lines. This path caches leaf
      // prose; lists, quotes and HTML retain the full document context.
      // A new line may still turn this dirty paragraph into a heading/table.
      const tail = parse(text.slice(offset))
      shiftPositions(tail, { ...start, offset })
      if (tail.position && previous.root.position) {
        tail.position.start = { ...previous.root.position.start }
      }
      root = { ...tail, children: [...previous.root.children.slice(0, -1), ...tail.children] }
      fence = openFence(text, root)
    } else {
      root = parse(text)
      fence = openFence(text, root)
    }
    list = listTail(text, root)
    previous = { text, root }
    return root
  }
}

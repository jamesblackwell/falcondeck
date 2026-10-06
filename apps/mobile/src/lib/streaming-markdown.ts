type Point = { line: number; column: number; offset?: number }
type PositionedNode = {
  type?: string
  value?: string
  position?: { start: Point; end: Point }
  children?: PositionedNode[]
}

type OpenFence = { contentStart: number; closer: RegExp }

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

/** Reuse completed prose and append literal text to an unclosed top-level fence. */
export function createStreamingMarkdownParser<
  Node extends PositionedNode,
  Root extends PositionedNode & { children: Node[] },
>(parse: (text: string) => Root) {
  let previous: { text: string; root: Root } | null = null
  let fence: OpenFence | null = null
  return (text: string, streaming: boolean): Root => {
    // Reference/footnote definitions can change earlier inline nodes. Final
    // messages and replacements always use the canonical full parser too.
    if (!streaming || text.includes(']:')) {
      previous = null
      fence = null
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
      const shift = (node: PositionedNode) => {
        if (node.position) {
          for (const point of [node.position.start, node.position.end]) {
            if (point.offset != null) point.offset += offset
            point.line += start.line - 1
          }
        }
        node.children?.forEach(shift)
      }
      shift(tail)
      if (tail.position && previous.root.position) {
        tail.position.start = { ...previous.root.position.start }
      }
      root = { ...tail, children: [...previous.root.children.slice(0, -1), ...tail.children] }
      fence = openFence(text, root)
    } else {
      root = parse(text)
      fence = openFence(text, root)
    }
    previous = { text, root }
    return root
  }
}

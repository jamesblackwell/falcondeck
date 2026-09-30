type Point = { line: number; column: number; offset?: number }
type PositionedNode = {
  position?: { start: Point; end: Point }
  children?: PositionedNode[]
}

/** Reparse the unfinished final root block; completed blocks keep their ASTs. */
export function createStreamingMarkdownParser<
  Node extends PositionedNode,
  Root extends PositionedNode & { children: Node[] },
>(parse: (text: string) => Root) {
  let previous: { text: string; root: Root } | null = null
  return (text: string, streaming: boolean): Root => {
    // Reference/footnote definitions can change earlier inline nodes. Final
    // messages and replacements always use the canonical full parser too.
    if (!streaming || text.includes(']:')) {
      previous = null
      return parse(text)
    }
    if (previous?.text === text) return previous.root
    const last = previous?.root.children.at(-1)
    const start = last?.position?.start
    const offset = start?.offset == null ? 0 : start.offset - start.column + 1
    let root: Root
    if (previous && text.startsWith(previous.text) && start && offset > 0) {
      // Start at the beginning of the line, preserving indentation for code,
      // lists and quotes. The previous final block stays in the dirty suffix:
      // a new line may still turn it into a setext heading, table or list.
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
    } else {
      root = parse(text)
    }
    previous = { text, root }
    return root
  }
}

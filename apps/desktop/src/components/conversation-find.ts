export function findTranscriptMatches(query: string) {
  const root = document.querySelector<HTMLElement>('[data-conversation-transcript]')
  if (!root || !query) return []
  const matches: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Array<{ node: Text; start: number; end: number }> = []
  let flattened = ''
  let current = walker.nextNode()
  while (current) {
    const node = current as Text
    const text = node.textContent ?? ''
    const start = flattened.length
    flattened += text
    nodes.push({ node, start, end: flattened.length })
    current = walker.nextNode()
  }
  const needle = query.toLocaleLowerCase()
  const haystack = flattened.toLocaleLowerCase()
  let start = haystack.indexOf(needle)
  while (start >= 0) {
    const end = start + query.length
    const startNode = nodes.find((entry) => start >= entry.start && start < entry.end)
    const endNode = nodes.find((entry) => end > entry.start && end <= entry.end)
    if (startNode && endNode) {
      const range = document.createRange()
      range.setStart(startNode.node, start - startNode.start)
      range.setEnd(endNode.node, end - endNode.start)
      matches.push(range)
    }
    start = haystack.indexOf(needle, start + Math.max(1, needle.length))
  }
  return matches
}

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react'

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

export function ConversationFindBar({ requestKey }: { requestKey: number }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<boolean | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const matchIndexRef = useRef(-1)
  const lastQueryRef = useRef('')

  useEffect(() => {
    if (requestKey <= 0) return
    setOpen(true)
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
  }, [requestKey])

  function find(backwards = false) {
    if (!query) {
      setFound(null)
      return
    }
    const matches = findTranscriptMatches(query)
    if (matches.length === 0) {
      setFound(false)
      matchIndexRef.current = -1
      lastQueryRef.current = query
      return
    }
    const isNewQuery = lastQueryRef.current !== query
    const nextIndex = isNewQuery
      ? (backwards ? matches.length - 1 : 0)
      : (matchIndexRef.current + (backwards ? -1 : 1) + matches.length) % matches.length
    const range = matches[nextIndex]
    const selection = window.getSelection()
    selection?.removeAllRanges()
    if (range) {
      selection?.addRange(range)
      range.startContainer.parentElement?.scrollIntoView?.({ block: 'center' })
    }
    matchIndexRef.current = nextIndex
    lastQueryRef.current = query
    setFound(true)
  }

  function close() {
    setOpen(false)
    setFound(null)
    matchIndexRef.current = -1
    lastQueryRef.current = ''
    window.getSelection()?.removeAllRanges()
  }

  if (!open) return null

  return (
    <div
      role="search"
      aria-label="Find in chat"
      className="z-20 flex items-center justify-end gap-1 border-b border-border-subtle bg-surface-2 px-3 py-2"
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          close()
        } else if (event.key === 'Enter') {
          event.preventDefault()
          find(event.shiftKey)
        }
      }}
    >
      <label className="fd-focus-within flex w-full max-w-sm items-center gap-2 rounded-[var(--fd-radius-md)] border border-border-default bg-surface-1 px-2.5">
        <Search className="h-3.5 w-3.5 text-fg-muted" aria-hidden="true" />
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setFound(null)
            matchIndexRef.current = -1
            lastQueryRef.current = ''
          }}
          placeholder="Find in chat"
          aria-label="Find text"
          className="h-8 min-w-0 flex-1 bg-transparent text-[length:var(--fd-text-sm)] text-fg-primary outline-none placeholder:text-fg-muted"
        />
        {found === false ? <span className="text-[length:var(--fd-text-2xs)] text-danger">No match</span> : null}
      </label>
      <button type="button" className="fd-focus rounded p-1.5 text-fg-muted hover:bg-surface-3 hover:text-fg-primary" aria-label="Previous match" onClick={() => find(true)}>
        <ChevronUp className="h-4 w-4" />
      </button>
      <button type="button" className="fd-focus rounded p-1.5 text-fg-muted hover:bg-surface-3 hover:text-fg-primary" aria-label="Next match" onClick={() => find(false)}>
        <ChevronDown className="h-4 w-4" />
      </button>
      <button type="button" className="fd-focus rounded p-1.5 text-fg-muted hover:bg-surface-3 hover:text-fg-primary" aria-label="Close find" onClick={close}>
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

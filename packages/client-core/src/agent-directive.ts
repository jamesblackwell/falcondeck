export type AgentDirectiveAttribute = readonly [key: string, value: string]

export type AgentDirective = {
  name: string
  attrs: AgentDirectiveAttribute[]
  /** Provider text inside the directive that was not a valid key/value pair. */
  unparsed: string | null
}

export type AgentMessageSegment =
  | { kind: 'markdown'; text: string }
  | ({ kind: 'directive' } & AgentDirective)

const DIRECTIVE_LINE_RE = /^::([a-z0-9][a-z0-9_-]*)\{(.*)\}\s*$/
const INCOMPLETE_DIRECTIVE_RE = /^::[a-z0-9][a-z0-9_-]*\{/
const DIRECTIVE_ATTRIBUTE_RE = /([a-zA-Z0-9_-]+)=(?:"([^"]*)"|'([^']*)'|([^\s]+))/g

function parseDirectiveAttributes(raw: string) {
  const attrs: AgentDirectiveAttribute[] = []
  const unmatched: string[] = []
  let cursor = 0
  let match: RegExpExecArray | null
  DIRECTIVE_ATTRIBUTE_RE.lastIndex = 0

  while ((match = DIRECTIVE_ATTRIBUTE_RE.exec(raw)) !== null) {
    const gap = raw.slice(cursor, match.index).trim()
    if (gap) unmatched.push(gap)
    attrs.push([match[1], match[2] ?? match[3] ?? match[4] ?? ''])
    cursor = match.index + match[0].length
  }

  const tail = raw.slice(cursor).trim()
  if (tail) unmatched.push(tail)
  return { attrs, unparsed: unmatched.join(' ') || null }
}

export function parseAgentDirectiveLine(line: string): AgentDirective | null {
  const candidate = line.trimEnd()
  // Transport directives start at column zero. Indented Markdown examples
  // are content rather than actions.
  if (candidate !== candidate.trimStart()) return null
  const match = DIRECTIVE_LINE_RE.exec(candidate)
  if (!match) return null
  return { name: match[1], ...parseDirectiveAttributes(match[2]) }
}

type AgentMessageLine = {
  directive: AgentDirective | null
  protectedByFence: boolean
}

function classifyAgentMessageLines(lines: string[]): AgentMessageLine[] {
  let fence: { marker: '`' | '~'; length: number } | null = null
  return lines.map((line) => {
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[1][0] === fence.marker &&
        fenceMatch[1].length >= fence.length &&
        fenceMatch[2].trim().length === 0
      ) {
        fence = null
      }
      return { directive: null, protectedByFence: true }
    }
    if (fenceMatch) {
      fence = {
        marker: fenceMatch[1][0] as '`' | '~',
        length: fenceMatch[1].length,
      }
      return { directive: null, protectedByFence: true }
    }
    return {
      directive: parseAgentDirectiveLine(line),
      protectedByFence: false,
    }
  })
}

export function splitAgentMessageSegments(
  text: string,
  suppressTrailingIncompleteDirective = false,
): AgentMessageSegment[] {
  if (!text.includes('::')) return [{ kind: 'markdown', text }]

  const segments: AgentMessageSegment[] = []
  let buffer: string[] = []
  const flush = () => {
    if (buffer.length === 0) return
    const chunk = buffer.join('\n')
    if (chunk.trim()) segments.push({ kind: 'markdown', text: chunk })
    buffer = []
  }
  const lines = text.split('\n')
  const classified = classifyAgentMessageLines(lines)

  lines.forEach((line, index) => {
    const { directive, protectedByFence } = classified[index]
    if (directive) {
      flush()
      segments.push({ kind: 'directive', ...directive })
      return
    }
    if (
      suppressTrailingIncompleteDirective &&
      !protectedByFence &&
      index === lines.length - 1 &&
      INCOMPLETE_DIRECTIVE_RE.test(line.trim())
    ) return
    buffer.push(line)
  })
  flush()
  return segments
}

export function stripAgentDirectiveLines(text: string): string {
  if (!text.includes('::')) return text
  const lines = text.split('\n')
  const classified = classifyAgentMessageLines(lines)
  return lines
    .filter((_, index) => !classified[index].directive)
    .join('\n')
}

export function agentDirectiveLabel(name: string) {
  return name.replace(/-/g, ' ')
}

/** Copy-safe provider Markdown that preserves agent actions without exposing their
 * machine transport syntax. An unfinished trailing directive is omitted only
 * while the response is streaming; malformed terminal text remains verbatim. */
export function agentMarkdownCopyText(text: string, streaming = false) {
  if (!text.includes('::')) return text
  const lines = text.split('\n')
  const classified = classifyAgentMessageLines(lines)
  const copied: string[] = []

  lines.forEach((line, index) => {
    const { directive, protectedByFence } = classified[index]
    if (directive) {
      const detail = [
        ...directive.attrs.map(([key, value]) => `${key}: ${value}`),
        ...(directive.unparsed ? [`detail: ${directive.unparsed}`] : []),
      ]
      copied.push(
        `Agent action: ${agentDirectiveLabel(directive.name)}${detail.length ? ` · ${detail.join(' · ')}` : ''}`,
      )
      return
    }
    if (
      streaming &&
      !protectedByFence &&
      index === lines.length - 1 &&
      INCOMPLETE_DIRECTIVE_RE.test(line.trim())
    ) return
    copied.push(line)
  })

  return streaming ? copied.join('\n').replace(/\n+$/, '') : copied.join('\n')
}

/** Compatibility name for assistant-response consumers. */
export const assistantMessageCopyText = agentMarkdownCopyText

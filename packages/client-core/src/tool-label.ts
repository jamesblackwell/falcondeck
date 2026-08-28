import type { ConversationItem } from './types'

type ToolCallItem = Extract<ConversationItem, { kind: 'tool_call' }>

/** Enough of a tool call to label it; keeps callers free of the full item shape. */
export type ToolCallLabelSource = Pick<ToolCallItem, 'title'> &
  Partial<Pick<ToolCallItem, 'output' | 'detail' | 'tool_kind'>>

export type ToolCallDescription = {
  /** Header text: the verb plus the file's name, never a screen-wide path. */
  label: string
  /** The file at full length, for diff links and syntax highlighting. */
  path: string | null
  /** True when `label` already names the file, so callers need not repeat it. */
  namesPath: boolean
}

/**
 * Git commits, git pushes, and isolated/sub-agent breakouts. These land as
 * ordinary execute rows from most harnesses, but they are the moments the
 * user actually cares about in a transcript.
 */
export type NotableToolKind = 'commit' | 'push' | 'breakout'

export type NotableToolAction = {
  kind: NotableToolKind
  /** Header text: `Commit feat: keep Studio`, never the raw execute line. */
  label: string
}

/** `/bin/zsh -lc 'git diff --stat'` is a wrapper, not the work the agent did. */
const SHELL_WRAPPER_RE = /^(?:\/[^\s]+\/)?(?:zsh|bash|sh)\s+-lc\s+(['"])([\s\S]*)\1$/

/**
 * Verbs whose argument is a file, so the path can shrink to its name. Every
 * entry is a title some harness actually emits (see `synthesize_tool_title` in
 * the daemon); search-shaped verbs are deliberately absent, since their
 * argument is a pattern that may contain slashes and must survive intact.
 */
const FILE_VERBS = new Set([
  'create',
  'delete',
  'edit',
  'inspect',
  'list',
  'move',
  'open',
  'patch',
  'read',
  'rename',
  'update',
  'view',
  'write',
])

/**
 * Names that say nothing on their own, so they keep their parent directory.
 * `index.ts` is every second file in a TypeScript tree; `Kernel.php` is not.
 */
const AMBIGUOUS_BASENAMES = new Set([
  '__init__',
  'config',
  'index',
  'layout',
  'lib',
  'main',
  'mod',
  'page',
  'route',
  'types',
  'utils',
])

/**
 * Result phrasings that name the file a tool touched, for daemons old enough
 * to still send a bare `Edit`. Matched against the head of the output only:
 * these are opening sentences, and a read's output is file content whose own
 * paths belong to the code, not to the tool call.
 */
const OUTPUT_PATH_RE =
  /^(?:The file (.+?) has been (?:updated|created|written)|File created successfully at:[ \t]*(.+?)[ \t]*$|Applied \d+ edits? to (.+?):)/m
const OUTPUT_HEAD_CHARS = 400

/** A title that ends in the one URL it is about, e.g. `Web fetch https://…`. */
const URL_TITLE_RE = /^(.*?\s)?(https?:\/\/[^\s]+)$/

/**
 * A URL as much of it as a header can afford: the host that identifies it and
 * the last segment that says which page. Query strings and tracking ids are
 * exactly the part nobody reads.
 */
export function compactUrl(url: string) {
  const [hostAndPath] = url.replace(/^https?:\/\//, '').split(/[?#]/)
  const segments = hostAndPath.split('/').filter(Boolean)
  const host = (segments.shift() ?? hostAndPath).replace(/^www\./, '')
  const last = segments[segments.length - 1]
  return last ? `${host}/${last}` : host
}

/** Trailing path segment, for labelling a link without spending the whole row. */
export function fileBaseName(path: string) {
  return path.split('/').filter(Boolean).pop() ?? path
}

/** Trailing path segment, plus its parent when the name alone says nothing. */
export function compactFilePath(path: string) {
  const segments = path.split('/').filter(Boolean)
  const base = segments[segments.length - 1]
  if (!base) return path
  if (segments.length < 2) return base
  const dot = base.lastIndexOf('.')
  const stem = dot > 0 ? base.slice(0, dot) : base
  return AMBIGUOUS_BASENAMES.has(stem.toLowerCase())
    ? `${segments[segments.length - 2]}/${base}`
    : base
}

/** Agents cite locations as `src/app.ts:42` or `src/app.ts:42:7`. */
export function stripFileLocation(token: string) {
  return token.replace(/:\d+(?::\d+)?$/, '')
}

/**
 * How a tool call should read in a header. Titles are freeform across
 * harnesses — `Edit /abs/path.ts` (Claude), ``Edit `/abs/path.ts` `` (ACP
 * agents), a bare `Edit` from an older daemon — so this resolves the file
 * once and shortens it for display, keeping the full path for links.
 */
export function describeToolCall(item: ToolCallLabelSource): ToolCallDescription {
  const notable = notableToolAction(item)
  if (notable) {
    return { label: notable.label, path: null, namesPath: false }
  }

  const title = unwrapAgentCommand(item.title.trim())
  const url = URL_TITLE_RE.exec(title)
  if (url) {
    return { label: `${url[1] ?? ''}${compactUrl(url[2])}`, path: null, namesPath: false }
  }

  const titlePath = filePathInTitle(title)
  if (titlePath) {
    const verb = title.slice(0, title.length - titlePath.raw.length).trim()
    const compact = compactFilePath(titlePath.path)
    return {
      label: verb ? `${verb} ${compact}` : compact,
      path: titlePath.path,
      namesPath: true,
    }
  }

  // A bare file verb ("Edit", "Write") says what happened but not to what.
  const recovered = isBareFileVerb(title) ? recoverFilePath(item) : null
  return recovered
    ? { label: `${title} ${compactFilePath(recovered)}`, path: recovered, namesPath: true }
    : { label: title, path: null, namesPath: false }
}

/** Header text alone, for callers with nowhere to put the path. */
export function toolCallLabel(item: ToolCallLabelSource) {
  return describeToolCall(item).label
}

/** The file a tool call acted on, at full length. */
export function toolCallFilePath(item: ToolCallLabelSource) {
  return describeToolCall(item).path
}

/** Strip `/bin/zsh -lc '…'` so the command itself is what callers label. */
export function unwrapShellCommand(title: string) {
  const shellMatch = SHELL_WRAPPER_RE.exec(title)
  return shellMatch ? shellMatch[2].trim() : title
}

const EXECUTE_WRAPPED_RE =
  /^(?:execute|run_terminal_command|run_terminal_cmd)\s+`([^`]*)`?/i
const EXECUTE_NAMED_RE = /^(?:run_terminal_command|run_terminal_cmd)\s+/i
const COMMIT_HELPER_RE = /(?:^|\/)commit\.(?:js|mjs|cjs|ts|py|sh)$/i
const SPAWN_KIND_RE = /^(?:spawn(?:_sub)?agent|spawn_agent|subagent(?:_activity)?|task|agent)$/i

/**
 * Drop the ACP `Execute \`…\`` wrapper, then any shell `-lc` wrapper, so a
 * git push reads as a git push whether Codex, Claude, or Grok ran it.
 */
export function unwrapAgentCommand(title: string) {
  let text = unwrapShellCommand(title.trim())
  const wrapped = EXECUTE_WRAPPED_RE.exec(text)
  if (wrapped) {
    return unwrapShellCommand((wrapped[1] ?? '').trim())
  }
  const named = EXECUTE_NAMED_RE.exec(text)
  if (named) {
    text = unwrapShellCommand(text.slice(named[0].length).trim())
  }
  return text
}

/** Commits, pushes, and breakouts — or null when this is ordinary tool work. */
export function notableToolAction(item: ToolCallLabelSource): NotableToolAction | null {
  if (isBreakoutItem(item)) {
    return { kind: 'breakout', label: breakoutLabel(item) }
  }

  const command = unwrapAgentCommand(item.title)
  if (!command) return null

  const helper = commitHelperMessage(command)
  if (helper !== undefined) {
    return { kind: 'commit', label: notableLabel('Commit', helper) }
  }

  const git = gitVerb(command)
  if (git === 'commit') {
    return { kind: 'commit', label: notableLabel('Commit', gitCommitMessage(command)) }
  }
  if (git === 'push') {
    return { kind: 'push', label: notableLabel('Push', gitPushTarget(command)) }
  }
  if (git === 'worktree') {
    return { kind: 'breakout', label: notableLabel('Breakout', gitWorktreeDetail(command)) }
  }
  return null
}

function notableLabel(verb: string, detail: string | null) {
  return detail ? `${verb} ${detail}` : verb
}

function isBreakoutItem(item: ToolCallLabelSource) {
  const detailKind = item.detail?.kind
  if (detailKind === 'subagent_activity' || detailKind === 'collab_agent') return true
  const kind = (item.tool_kind ?? '').trim()
  if (SPAWN_KIND_RE.test(kind.replace(/[\s-]+/g, '_'))) return true
  const command = unwrapAgentCommand(item.title).toLowerCase()
  if (command.startsWith('agent:') || command.startsWith('breakout')) return true
  if (isolationArgument(item.detail) === 'worktree') return true
  return false
}

function breakoutLabel(item: ToolCallLabelSource) {
  if (item.detail?.kind === 'subagent_activity') {
    return notableLabel('Breakout', item.detail.agent_path || null)
  }
  if (item.detail?.kind === 'collab_agent') {
    const count = item.detail.receiver_thread_ids.length
    return notableLabel(
      'Breakout',
      count > 0 ? `${count} agent${count === 1 ? '' : 's'}` : item.detail.model,
    )
  }
  const command = unwrapAgentCommand(item.title)
  const agent = /^agent:\s*(.+)$/i.exec(command)
  if (agent) return notableLabel('Breakout', collapseHeaderDetail(agent[1]))
  const type = argumentString(item.detail, ['description', 'subagent_type', 'prompt'])
  return notableLabel('Breakout', type ? collapseHeaderDetail(type) : null)
}

function isolationArgument(detail: ToolCallItem['detail'] | undefined) {
  const value = argumentString(detail, ['isolation'])
  return value ? value.toLowerCase() : null
}

function argumentString(detail: ToolCallItem['detail'] | undefined, keys: string[]) {
  if (!detail || (detail.kind !== 'dynamic' && detail.kind !== 'mcp')) return null
  const args = detail.arguments
  if (!args || typeof args !== 'object') return null
  for (const key of keys) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function commitHelperMessage(command: string) {
  const tokens = tokenizeCommand(command)
  if (tokens.length === 0) return undefined
  let index = 0
  const program = basename(tokens[index] ?? '')
  if (['node', 'nodejs', 'bun', 'deno', 'python', 'python3', 'bash', 'sh', 'zsh'].includes(program)) {
    index += 1
    while (index < tokens.length && tokens[index]!.startsWith('-')) index += 1
  }
  const script = tokens[index]
  if (!script || !COMMIT_HELPER_RE.test(script.replace(/\\/g, '/'))) return undefined
  const message = tokens[index + 1]
  return message ? collapseHeaderDetail(message) : null
}

function gitVerb(command: string) {
  const tokens = tokenizeCommand(command)
  const program = tokens[0]
  if (!program || basename(program) !== 'git') return null
  let index = 1
  while (index < tokens.length) {
    const token = tokens[index]!
    if (token === '-C' || token === '-c') {
      index += 2
      continue
    }
    if (token.startsWith('--git-dir') || token.startsWith('--work-tree')) {
      index += token.includes('=') ? 1 : 2
      continue
    }
    if (token.startsWith('-')) {
      index += 1
      continue
    }
    return token
  }
  return null
}

function gitCommitMessage(command: string) {
  const tokens = tokenizeCommand(command)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token === '-m' || token === '--message') {
      const next = tokens[index + 1]
      return next ? collapseHeaderDetail(next) : null
    }
    if (token.startsWith('--message=')) {
      return collapseHeaderDetail(token.slice('--message='.length))
    }
  }
  return null
}

function gitPushTarget(command: string) {
  const tokens = tokenizeCommand(command)
  const rest: string[] = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (rest.length === 0 && basename(token) === 'git') continue
    if (rest.length === 0 && token === 'push') continue
    if (token === '-C' || token === '-c') {
      index += 1
      continue
    }
    if (token.startsWith('-')) continue
    rest.push(token)
    if (rest.length === 2) break
  }
  return rest.length > 0 ? rest.join(' ') : null
}

function gitWorktreeDetail(command: string) {
  const tokens = tokenizeCommand(command)
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if ((token === '-b' || token === '--branch') && tokens[index + 1]) {
      return tokens[index + 1] ?? null
    }
  }
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]!
    if (token.startsWith('-') || token === 'git' || token === 'worktree' || token === 'add') continue
    return basename(token)
  }
  return null
}

function collapseHeaderDetail(value: string) {
  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (trimmed.length <= 72) return trimmed
  return `${trimmed.slice(0, 71).trimEnd()}…`
}

function basename(path: string) {
  return path.split(/[/\\]/).filter(Boolean).pop() ?? path
}

function tokenizeCommand(command: string) {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | '`' | null = null
  for (const char of command) {
    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (current) tokens.push(current)
  return tokens
}

function looksLikePath(token: string) {
  if (!token || token.includes('://') || token.startsWith('-')) return false
  if (!token.includes('/')) return false
  // A glob is a pattern over paths, not a path — shortening it loses its point.
  return !/[*?]/.test(token)
}

/**
 * The path in a `<verb> <path>` title, with the raw token it was written as
 * (ACP agents quote theirs in backticks) so the verb can be recovered by
 * length. Anything with more than one trailing token is prose or a command.
 */
function filePathInTitle(title: string) {
  const words = title.split(/\s+/)
  const raw = words[words.length - 1]
  if (!raw) return null
  const verb = words.slice(0, -1).join(' ')
  if (verb && !FILE_VERBS.has(words[0].toLowerCase())) return null

  const path = stripFileLocation(raw.replace(/^`|`$/g, ''))
  return looksLikePath(path) ? { path, raw } : null
}

function isBareFileVerb(title: string) {
  const words = title.split(/\s+/)
  return FILE_VERBS.has(words[0].toLowerCase()) && words.every((word) => /^[A-Za-z]+$/.test(word))
}

function recoverFilePath(item: ToolCallLabelSource): string | null {
  const fromDetail = detailFilePath(item.detail)
  if (fromDetail) return fromDetail
  if (!item.output) return null
  const match = OUTPUT_PATH_RE.exec(item.output.slice(0, OUTPUT_HEAD_CHARS))
  const path = (match?.[1] ?? match?.[2] ?? match?.[3])?.trim()
  return path && looksLikePath(path) ? path : null
}

function detailFilePath(detail: ToolCallItem['detail']): string | null {
  if (!detail) return null
  const args = detail.kind === 'dynamic' || detail.kind === 'mcp' ? detail.arguments : null
  if (!args || typeof args !== 'object') return null
  for (const key of ['file_path', 'filePath', 'path', 'target_file', 'notebook_path']) {
    const value = (args as Record<string, unknown>)[key]
    if (typeof value === 'string' && looksLikePath(value)) return value
  }
  return null
}

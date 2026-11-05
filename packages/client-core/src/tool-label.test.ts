import { describe, expect, it } from 'vitest'

import {
  compactFilePath,
  describeToolCall,
  notableToolAction,
  toolCallAgentTitle,
  toolCallFilePath,
  toolCallLabel,
  toolCallReadsAsProse,
  toolThreadTarget,
} from './tool-label'

describe('tool call labels', () => {
  it('shrinks an absolute path to the file being edited', () => {
    expect(toolCallLabel({ title: 'Edit /Users/james/www/sites/app/Console/Kernel.php' })).toBe(
      'Edit Kernel.php',
    )
  })

  it('unquotes the backticked path ACP agents send', () => {
    expect(toolCallLabel({ title: 'Read `/Users/james/www/sites/app/AGENTS.md`' })).toBe(
      'Read AGENTS.md',
    )
  })

  it('names the file for a bare verb by reading the result', () => {
    expect(
      toolCallLabel({
        title: 'Edit',
        output: 'The file /Users/james/www/sites/app/Http/Kernel.php has been updated.',
      }),
    ).toBe('Edit Kernel.php')
  })

  it('takes the file from structured tool arguments when the result is opaque', () => {
    expect(
      toolCallLabel({
        title: 'Write',
        detail: {
          kind: 'dynamic',
          tool: 'write',
          namespace: null,
          arguments: { file_path: '/repo/src/server/handler.ts' },
          content_items: [],
          success: true,
          duration_ms: null,
        },
      }),
    ).toBe('Write handler.ts')
  })

  it('keeps the parent directory when the file name says nothing', () => {
    expect(toolCallLabel({ title: 'Edit /repo/packages/chat-ui/src/index.ts' })).toBe(
      'Edit src/index.ts',
    )
  })

  it('drops a line citation from the path', () => {
    expect(toolCallLabel({ title: 'Read /repo/src/app.tsx:42:7' })).toBe('Read app.tsx')
  })

  it('leaves a bare verb alone when nothing names a file', () => {
    expect(toolCallLabel({ title: 'Edit' })).toBe('Edit')
  })

  it('unwraps a shell command without touching its arguments', () => {
    expect(toolCallLabel({ title: "/bin/zsh -lc 'git diff --stat src/app.ts'" })).toBe(
      'git diff --stat src/app.ts',
    )
  })

  it('leaves search patterns intact, since a slash there is not a path', () => {
    expect(toolCallLabel({ title: 'Search src/.*\\.tsx$' })).toBe('Search src/.*\\.tsx$')
    expect(toolCallLabel({ title: 'Find packages/*/src/index.ts' })).toBe(
      'Find packages/*/src/index.ts',
    )
  })

  it('shortens a fetched URL to the host and the page', () => {
    expect(toolCallLabel({ title: 'Web fetch https://www.example.com/docs/page.html' })).toBe(
      'Web fetch example.com/page.html',
    )
    expect(toolCallLabel({ title: 'Web fetch https://example.com' })).toBe(
      'Web fetch example.com',
    )
    // A query string is the part of a URL nobody reads in a header.
    expect(
      toolCallLabel({ title: 'Web fetch https://example.com/search?q=a&utm_source=b' }),
    ).toBe('Web fetch example.com/search')
  })

  it('reports the full path so file links still resolve', () => {
    expect(toolCallFilePath({ title: 'Edit `/repo/src/app.tsx`' })).toBe('/repo/src/app.tsx')
    expect(
      toolCallFilePath({ title: 'Edit', output: 'The file /repo/src/app.tsx has been updated.' }),
    ).toBe('/repo/src/app.tsx')
    expect(toolCallFilePath({ title: 'Edit' })).toBeNull()
  })

  it('compacts a bare path to its file name', () => {
    expect(compactFilePath('/repo/src/app.tsx')).toBe('app.tsx')
    expect(compactFilePath('app.tsx')).toBe('app.tsx')
  })

  it('shortens every verb the daemon emits, not just editing ones', () => {
    expect(toolCallLabel({ title: 'List /repo/packages/chat-ui/src' })).toBe('List src')
    expect(toolCallLabel({ title: 'Inspect /repo/src/app.tsx' })).toBe('Inspect app.tsx')
  })

  it('reports whether the label already names the file, so links need not repeat it', () => {
    expect(describeToolCall({ title: 'Edit /repo/src/app.tsx' })).toEqual({
      label: 'Edit app.tsx',
      path: '/repo/src/app.tsx',
      namesPath: true,
    })
    expect(describeToolCall({ title: 'npm test' })).toEqual({
      label: 'npm test',
      path: null,
      namesPath: false,
    })
  })

  it('reads only the head of a result, not a whole file of output', () => {
    const decoy = `${'x'.repeat(2000)}\nThe file /repo/src/decoy.ts has been updated.`
    expect(toolCallLabel({ title: 'Edit', output: decoy })).toBe('Edit')
  })

  it('unwraps an ACP execute wrapper before labelling the command', () => {
    expect(toolCallLabel({ title: 'Execute `ls crates/`' })).toBe('ls crates/')
    expect(toolCallLabel({ title: 'Run checks' })).toBe('Run checks')
  })
})

describe('notable tool actions', () => {
  it('rewrites git commits and commit helpers as Commit', () => {
    expect(notableToolAction({ title: 'git commit -m "feat: keep Studio"' })).toEqual({
      kind: 'commit',
      label: 'Commit feat: keep Studio',
    })
    expect(
      notableToolAction({
        title: 'Execute `node scripts/commit.js "feat: keep Studio in the session"`',
      }),
    ).toEqual({
      kind: 'commit',
      label: 'Commit feat: keep Studio in the session',
    })
    expect(toolCallLabel({ title: "/bin/zsh -lc 'git commit -m foo'" })).toBe('Commit foo')
  })

  it('rewrites git pushes as Push with the remote and ref', () => {
    expect(notableToolAction({ title: 'Execute `git push origin main`' })).toEqual({
      kind: 'push',
      label: 'Push origin main',
    })
    expect(notableToolAction({ title: 'git push' })).toEqual({
      kind: 'push',
      label: 'Push',
    })
  })

  it('rewrites isolated work and sub-agents as Breakout', () => {
    expect(notableToolAction({ title: 'git worktree add -b fd/fix-login ../fix-login' })).toEqual({
      kind: 'breakout',
      label: 'Breakout fd/fix-login',
    })
    expect(notableToolAction({ title: 'Agent: explore the auth flow' })).toEqual({
      kind: 'breakout',
      label: 'Breakout explore the auth flow',
    })
    expect(notableToolAction({ title: 'spawn_subagent', tool_kind: 'spawn_subagent' })).toEqual({
      kind: 'breakout',
      label: 'Breakout',
    })
    expect(
      notableToolAction({
        title: 'Task',
        tool_kind: 'task',
        detail: {
          kind: 'dynamic',
          tool: 'task',
          namespace: null,
          arguments: { description: 'review the diff', isolation: 'worktree' },
          content_items: [],
          success: true,
          duration_ms: null,
        },
      }),
    ).toEqual({
      kind: 'breakout',
      label: 'Breakout review the diff',
    })
  })

  it('leaves ordinary commands alone', () => {
    expect(notableToolAction({ title: 'Execute `git status --short`' })).toBeNull()
    expect(notableToolAction({ title: 'npm test' })).toBeNull()
    expect(notableToolAction({ title: 'Read /repo/src/app.tsx' })).toBeNull()
  })
})

describe('MCP tool rows', () => {
  const link = { thread_id: 'claude-thread-1', lead: 'Created task:', subject: 'Fix login' }
  const display = {
    is_read_only: false,
    has_side_effect: true,
    is_error: false,
    artifact_kind: 'none',
    activity_kind: 'other',
    history_mode: 'full',
    summary_hint: null,
    thread_link: link,
  } as const
  const created = { title: 'Created task: Fix login', display }

  it('uses the current title when the task has been renamed', () => {
    expect(toolThreadTarget(created, () => 'Fix the login page')).toEqual({
      threadId: 'claude-thread-1',
      href: 'falcondeck://thread/claude-thread-1',
      label: 'Created task: Fix the login page',
    })
  })

  it('falls back to the name the call used, then to the title', () => {
    expect(toolThreadTarget(created, () => null)?.label).toBe('Created task: Fix login')
    expect(
      toolThreadTarget({
        title: 'Viewing task',
        display: { ...display, thread_link: { ...link, lead: 'Viewing task', subject: null } },
      })?.label,
    ).toBe('Viewing task')
  })

  it('stays plain text without a link, or with an id a link cannot carry', () => {
    expect(toolThreadTarget({ title: 'Created task' })).toBeNull()
    expect(
      toolThreadTarget({
        title: 'Created task',
        display: { ...display, thread_link: { ...link, thread_id: '../secret path' } },
      }),
    ).toBeNull()
  })

  it('sets MCP and tool search rows as prose, and commands as code', () => {
    expect(
      toolCallReadsAsProse({ title: 'Listed tasks', tool_kind: 'mcp__falcondeck__list' }),
    ).toBe(true)
    expect(toolCallReadsAsProse({ title: 'Loaded tool: Read', tool_kind: 'ToolSearch' })).toBe(true)
    expect(toolCallReadsAsProse({ title: 'git status', tool_kind: 'commandExecution' })).toBe(false)
  })

  it('leaves a friendly title that quotes a URL or path readable', () => {
    expect(toolCallLabel({ title: 'Created task: Fix src/app.ts' })).toBe(
      'Created task: Fix src/app.ts',
    )
  })

  it('gives agents the tool that ran, not the friendly title', () => {
    expect(
      toolCallAgentTitle({
        title: 'Created task: Fix login',
        tool_kind: 'mcp__falcondeck-extensions__falcondeck_create_thread',
      }),
    ).toBe('falcondeck-extensions · falcondeck create thread')
    expect(
      toolCallAgentTitle({
        title: 'Loaded tool: Read',
        tool_kind: 'ToolSearch',
        detail: {
          kind: 'dynamic',
          tool: 'ToolSearch',
          namespace: null,
          arguments: { query: 'select:Read' },
          content_items: [],
          success: null,
          duration_ms: null,
        },
      }),
    ).toBe('Search tools: select:Read')
    expect(toolCallAgentTitle({ title: 'Read /a.ts', tool_kind: 'Read' })).toBe('Read /a.ts')
  })
})

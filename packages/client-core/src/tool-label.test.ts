import { describe, expect, it } from 'vitest'

import { compactFilePath, describeToolCall, toolCallFilePath, toolCallLabel } from './tool-label'

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

  it('leaves a URL alone', () => {
    expect(toolCallLabel({ title: 'Web fetch https://example.com/docs/page.html' })).toBe(
      'Web fetch https://example.com/docs/page.html',
    )
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
})

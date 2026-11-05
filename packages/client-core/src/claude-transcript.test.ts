import { claudeEditDiff } from './claude-tool-evidence'
import { expect, it } from 'vitest'
import { deriveConversationPresentation } from './conversation'
import { normalizeConversationItem } from './normalization'

it('preserves Claude child evidence and keeps a compact tool row out of the default work fold', () => {
  const item = normalizeConversationItem({
    kind: 'tool_call', id: 'parent', title: 'Agent: Inspect files', tool_kind: 'Agent', status: 'completed',
    output: 'Report', created_at: '2026-11-05T12:00:00Z',
    detail: { kind: 'dynamic', tool: 'Agent', namespace: 'claude', arguments: { prompt: 'Inspect fixtures' }, claude: { calls: [{ id: 'a', title: 'du -sk *', tool_kind: 'Bash', status: 'completed', arguments: { command: 'du -sk *' }, output: '42' }], result: { totalTokens: 12 } } },
  })
  expect(item.kind === 'tool_call' && item.detail?.kind === 'dynamic' && item.detail.claude?.calls[0]?.output).toBe('42')
  const blocks = deriveConversationPresentation([item], null).history_blocks
  expect(blocks).toHaveLength(1)
  expect(blocks[0]).toMatchObject({ kind: 'item', default_open: false, suppress_read_only_detail: false })
})

it('renders Claude edit hunks without losing paths/counts in the original result', () => {
  expect(claudeEditDiff({ structuredPatch: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-before', '+after'] }] })).toBe('@@ -2,1 +2,1 @@\n-before\n+after')
  expect(claudeEditDiff({ structuredPatch: [null, { lines: ['bad'] }] })).toBeNull()
})

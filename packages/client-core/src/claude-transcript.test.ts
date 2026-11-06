import { claudeEditDiff } from './claude-tool-evidence'
import { expect, it } from 'vitest'
import { deriveConversationPresentation } from './conversation'
import { normalizeConversationItem } from './normalization'

it('preserves Claude child evidence and keeps richer tool evidence inside the default work fold', () => {
  const item = normalizeConversationItem({
    kind: 'tool_call', id: 'parent', title: 'Agent: Inspect files', tool_kind: 'Agent', status: 'completed',
    output: 'Report', created_at: '2026-11-05T12:00:00Z',
    detail: { kind: 'dynamic', tool: 'Agent', namespace: 'claude', arguments: { prompt: 'Inspect fixtures' }, claude: { calls: [{ id: 'a', title: 'du -sk *', tool_kind: 'Bash', status: 'completed', arguments: { command: 'du -sk *' }, output: '42' }], result: { totalTokens: 12 } } },
  })
  expect(item.kind === 'tool_call' && item.detail?.kind === 'dynamic' && item.detail.claude?.calls[0]?.output).toBe('42')
  const blocks = deriveConversationPresentation([item], null).history_blocks
  expect(blocks).toHaveLength(1)
  expect(blocks[0]).toMatchObject({ kind: 'work_session' })
})

it('renders Claude edit hunks without losing paths/counts in the original result', () => {
  expect(claudeEditDiff({ structuredPatch: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-before', '+after'] }] })).toBe('@@ -2,1 +2,1 @@\n-before\n+after')
  expect(claudeEditDiff({ structuredPatch: [null, { lines: ['bad'] }] })).toBeNull()
})

it('keeps thirty Claude reads and one failure in the existing collapsed fold', () => {
  const message = (id: string) => normalizeConversationItem({ kind: 'assistant_message', id, text: id, created_at: '2026-11-05T12:00:00Z' })
  const tools = Array.from({ length: 31 }, (_, index) => normalizeConversationItem({
    kind: 'tool_call', id: String(index), title: `Read file-${index}.ts`, tool_kind: 'Read', status: index === 30 ? 'failed' : 'completed', output: index === 30 ? 'Read failed' : 'contents', created_at: '2026-11-05T12:00:00Z',
    detail: { kind: 'dynamic', namespace: 'claude', tool: 'Read', arguments: { file_path: `file-${index}.ts` }, claude: { calls: [], result: null } },
  }))
  const blocks = deriveConversationPresentation([message('before'), ...tools, message('after')], null).history_blocks
  expect(blocks.map(block => block.kind)).toEqual(['item', 'work_session', 'item'])
  expect(blocks[1]?.kind === 'work_session' && blocks[1].items).toHaveLength(31)
})


it.each([
  ['git diff -- SKILL.md', 'completed', 'fixture diff'],
  ['echo SKILL.md', 'completed', 'SKILL.md'],
  ['cat README.md # SKILL.md', 'completed', 'readme'],
  ['cat SKILL.md.bak', 'completed', 'backup'],
  ['cat missing/SKILL.md', 'failed', 'No such file'],
  ['cat /example/SKILL.md', 'completed', null],
])('preserves Bash filename mentions and failed-read diagnostics: %s', (title, status, expected) => {
  const item = normalizeConversationItem({ kind: 'tool_call', id: 'skill-command', title, tool_kind: 'Bash', status,
    output: expected ?? 'skill body', created_at: '2026-11-06T12:00:00Z' });
  expect(item.kind === 'tool_call' ? item.output : undefined).toBe(expected);
});

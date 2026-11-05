import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, expect, it } from 'vitest'
import { cleanup, renderComponent, textOf } from '@/test/render'
import { ClaudeToolEvidence } from './ClaudeToolEvidence'

afterEach(cleanup)
it('shows prompt and child status, opening one child reveals its full arguments and output', () => {
  const renderer = renderComponent(<ClaudeToolEvidence detail={{ kind: 'dynamic', tool: 'Agent', namespace: 'claude', arguments: { prompt: 'Measure fixtures' }, content_items: [], duration_ms: null, success: true, claude: { result: null, calls: [{ id: 'a', title: 'du -sk *', tool_kind: 'Bash', status: 'completed', arguments: { command: 'du -sk *', description: 'Measure directories' }, output: '42 fixtures' }] } }} />)
  expect(textOf(renderer)).toContain('Measure fixtures')
  expect(textOf(renderer)).toContain('Bash: du -sk * · completed')
  expect(textOf(renderer)).not.toContain('42 fixtures')
  act(() => renderer.root.findAllByType('Pressable' as any).find(node => node.props.accessibilityState?.expanded === false)!.props.onPress())
  expect(textOf(renderer)).toContain('42 fixtures')
  expect(textOf(renderer)).toContain('Measure directories')
})

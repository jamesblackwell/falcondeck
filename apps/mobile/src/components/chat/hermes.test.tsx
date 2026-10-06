import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'

import { normalizeWorkspaceSummary } from '@falcondeck/client-core'
import fixture from '../../../../../packages/client-core/src/test-fixtures/hermes.json'
import { cleanup, renderComponent, textOf } from '@/test/render'
import { ChatInput } from './ChatInput'
import { collaborationModeItems, collaborationModeLabel } from './composerModes'

afterEach(cleanup)

const agent = normalizeWorkspaceSummary({ agents: [fixture.agent] }).agents[0]!
const props: React.ComponentProps<typeof ChatInput> = {
  value: '', onChangeText: vi.fn(), onSubmit: vi.fn(), onPickImages: vi.fn(),
  onRemoveAttachment: vi.fn(), attachments: [], skills: [], models: agent.models,
  selectedModel: 'openai-codex:gpt-5.6-luna', selectedEffort: null, effortOptions: [],
  selectedProvider: 'hermes', showProviderSelector: false,
  onSelectModel: vi.fn(), onSelectEffort: vi.fn(), onSelectProvider: vi.fn(),
  capabilities: agent.capabilities, collaborationModes: agent.collaboration_modes,
  selectedCollaborationMode: 'default',
}

it('offers native edit modes and sends the opaque ID selected on a phone', () => {
  const onSelectCollaborationMode = vi.fn()
  const renderer = renderComponent(<ChatInput {...props} onSelectCollaborationMode={onSelectCollaborationMode} />)
  act(() => renderer.root.findByProps({ accessibilityLabel: 'Add to prompt' }).props.onPress())
  act(() => renderer.root.findByProps({ accessibilityLabel: 'Mode' }).props.onPress())
  expect(textOf(renderer)).toContain('Ask before edits')
  act(() => renderer.root.findByProps({ accessibilityLabel: 'Accept edits' }).props.onPress())
  expect(onSelectCollaborationMode).toHaveBeenCalledWith('accept_edits')
  expect(renderer.root.findAllByProps({ accessibilityLabel: 'Accept edits' })).toHaveLength(0)
})

it('hides absent reasoning choices and mode catalogs while retaining image actions', () => {
  const renderer = renderComponent(<ChatInput {...props} collaborationModes={[]} onSelectCollaborationMode={vi.fn()} />)
  expect(textOf(renderer)).not.toContain('Medium')
  act(() => renderer.root.findByProps({ accessibilityLabel: 'Add to prompt' }).props.onPress())
  expect(textOf(renderer)).toContain('Photos')
  expect(renderer.root.findAllByProps({ accessibilityLabel: 'Mode' })).toHaveLength(0)
})

it('uses catalog labels and IDs for modes unknown to this client', () => {
  const mode = { ...agent.collaboration_modes[0]!, id: 'team:mode/v2', label: 'Team review' }
  expect(collaborationModeItems([mode])).toEqual([{ value: 'team:mode/v2', label: 'Team review' }])
  expect(collaborationModeLabel('team:mode/v2', [mode])).toBe('Team review')
})

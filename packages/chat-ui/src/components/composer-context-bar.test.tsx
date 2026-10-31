import { fireEvent, render, screen } from '@testing-library/react'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { WorkspaceSummary } from '@falcondeck/client-core'
import { ComposerContextBar } from './composer-context-bar'

beforeAll(() => { Element.prototype.scrollIntoView ??= vi.fn() })

const project = { id: 'ws', path: '/project', kind: 'project' } as WorkspaceSummary
const props = { workspaces: [project], selectedWorkspace: project, onSelectWorkspace: vi.fn(), selectedIsolation: 'project_folder' as const, onIsolationChange: vi.fn(), onExecutionTargetChange: vi.fn() }

describe('composer execution location', () => {
  it('lets the normal new task composer choose Cloud', async () => {
    const onChange = vi.fn()
    render(<ComposerContextBar {...props} executionTarget="local" onExecutionTargetChange={onChange} />)
    const location = screen.getByRole('combobox', { name: 'Run in' })
    expect(location).toHaveTextContent('Local')
    fireEvent.keyDown(location, { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'Cloud' }))
    expect(onChange).toHaveBeenCalledWith('cloud')
  })
  it('shows the cloud copy without local branch or isolation controls', () => {
    render(<ComposerContextBar {...props} executionTarget="cloud" />)
    expect(screen.getByRole('combobox', { name: 'Run in' })).toHaveTextContent('Cloud')
    expect(screen.getByText('Cloud copy')).toBeInTheDocument()
    expect(screen.queryByRole('combobox', { name: 'Work in' })).not.toBeInTheDocument()
  })
  it('keeps the source host separate from cloud execution', async () => {
    render(<ComposerContextBar {...props} executionTarget="cloud" workspaceHosts={{ ws: { name: 'Build server', connected: true } }} />)
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Run in' }), { key: 'ArrowDown' })
    expect(await screen.findByRole('option', { name: 'Build server' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Cloud' })).toBeInTheDocument()
  })
})

import React from 'react'
import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ThreadGoal } from '@falcondeck/client-core'

import { cleanup, renderComponent, textOf } from '../../test/render'
import { GoalBanner } from './GoalBanner'
import { GoalSheet } from './GoalSheet'

afterEach(cleanup)

function goal(overrides: Partial<ThreadGoal> = {}): ThreadGoal {
  return { objective: 'All tests pass and lint is clean', status: 'active', ...overrides }
}

const sheetDefaults = {
  onSetGoal: vi.fn(async () => {}),
  onClearGoal: vi.fn(async () => {}),
  onSetGoalStatus: vi.fn(async () => {}),
  onClose: vi.fn(),
}

function buttonLabelled(renderer: ReturnType<typeof renderComponent>, label: string) {
  // Button takes its text as `label`; bare Pressables carry accessibilityLabel.
  const node = renderer.root.findAll(
    (n) => n.props?.label === label || n.props?.accessibilityLabel === label,
    { deep: true },
  )[0]
  if (!node) throw new Error(`no button labelled "${label}"`)
  return node
}

function inputLabelled(renderer: ReturnType<typeof renderComponent>, label: string) {
  const node = renderer.root
    .findAll((n) => n.props?.accessibilityLabel === label, { deep: true })
    .at(-1)
  if (!node) throw new Error(`no input labelled "${label}"`)
  return node
}

describe('GoalSheet with no goal', () => {
  it('explains what a goal does and offers the objective field', () => {
    const r = renderComponent(<GoalSheet goal={null} provider="codex" {...sheetDefaults} />)
    expect(textOf(r)).toContain('Set a goal')
    expect(textOf(r)).toContain('The agent keeps working turns until the objective is met.')
  })

  it('offers a token budget on Codex only', () => {
    const codex = renderComponent(<GoalSheet goal={null} provider="codex" {...sheetDefaults} />)
    expect(() => inputLabelled(codex, 'Token budget')).not.toThrow()

    const claude = renderComponent(<GoalSheet goal={null} provider="claude" {...sheetDefaults} />)
    expect(() => inputLabelled(claude, 'Token budget')).toThrow()
  })

  it('will not submit an empty objective', () => {
    const r = renderComponent(<GoalSheet goal={null} provider="codex" {...sheetDefaults} />)
    expect(buttonLabelled(r, 'Set goal').props.disabled).toBe(true)
  })

  it('submits the trimmed objective with the parsed budget', async () => {
    const onSetGoal = vi.fn(async () => {})
    const r = renderComponent(
      <GoalSheet goal={null} provider="codex" {...sheetDefaults} onSetGoal={onSetGoal} />,
    )

    act(() => {
      inputLabelled(r, 'Objective').props.onChangeText('  Ship the release  ')
      inputLabelled(r, 'Token budget').props.onChangeText('100000')
    })
    await act(async () => {
      buttonLabelled(r, 'Set goal').props.onPress()
    })

    expect(onSetGoal).toHaveBeenCalledWith('Ship the release', 100000)
  })

  it('surfaces a failure inline instead of closing', async () => {
    const onClose = vi.fn()
    const r = renderComponent(
      <GoalSheet
        goal={null}
        provider="claude"
        {...sheetDefaults}
        onClose={onClose}
        onSetGoal={async () => {
          throw new Error('an objective is required to set a goal')
        }}
      />,
    )

    act(() => {
      inputLabelled(r, 'Objective').props.onChangeText('Do the thing')
    })
    await act(async () => {
      buttonLabelled(r, 'Set goal').props.onPress()
    })

    expect(textOf(r)).toContain('an objective is required to set a goal')
    expect(onClose).not.toHaveBeenCalled()
  })
})

describe('GoalSheet with a goal', () => {
  it('shows the objective, its status, and the usage line', () => {
    const r = renderComponent(
      <GoalSheet
        goal={goal({ tokens_used: 12_000, token_budget: 100_000 })}
        provider="codex"
        {...sheetDefaults}
      />,
    )
    expect(textOf(r)).toContain('All tests pass and lint is clean')
    expect(textOf(r)).toContain('Active')
    expect(textOf(r)).toContain('12k of 100k tokens')
  })

  it('offers Pause on Codex and Resume once paused', () => {
    const active = renderComponent(<GoalSheet goal={goal()} provider="codex" {...sheetDefaults} />)
    expect(textOf(active)).toContain('Pause')

    const paused = renderComponent(
      <GoalSheet goal={goal({ status: 'paused' })} provider="codex" {...sheetDefaults} />,
    )
    expect(textOf(paused)).toContain('Resume')
  })

  it('does not offer Pause on Claude', () => {
    const r = renderComponent(<GoalSheet goal={goal()} provider="claude" {...sheetDefaults} />)
    expect(textOf(r)).not.toContain('Pause')
    expect(textOf(r)).toContain('Clear goal')
  })

  it('pauses through the status callback, keeping the objective', async () => {
    const onSetGoalStatus = vi.fn(async () => {})
    const r = renderComponent(
      <GoalSheet goal={goal()} provider="codex" {...sheetDefaults} onSetGoalStatus={onSetGoalStatus} />,
    )
    await act(async () => {
      buttonLabelled(r, 'Pause').props.onPress()
    })
    expect(onSetGoalStatus).toHaveBeenCalledWith('paused')
  })

  it('clears the goal and closes', async () => {
    const onClearGoal = vi.fn(async () => {})
    const onClose = vi.fn()
    const r = renderComponent(
      <GoalSheet
        goal={goal()}
        provider="codex"
        {...sheetDefaults}
        onClearGoal={onClearGoal}
        onClose={onClose}
      />,
    )
    await act(async () => {
      buttonLabelled(r, 'Clear goal').props.onPress()
    })
    expect(onClearGoal).toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })
})

describe('GoalBanner', () => {
  it('renders nothing without a goal', () => {
    expect(renderComponent(<GoalBanner goal={null} onPress={vi.fn()} />).toJSON()).toBeNull()
  })

  it('shows the objective and status, and opens the sheet on press', () => {
    const onPress = vi.fn()
    const r = renderComponent(<GoalBanner goal={goal({ status: 'paused' })} onPress={onPress} />)

    expect(textOf(r)).toContain('All tests pass and lint is clean')
    expect(textOf(r)).toContain('Paused')

    act(() => {
      r.root.findByType('Pressable' as never).props.onPress()
    })
    expect(onPress).toHaveBeenCalled()
  })

  it('reads the whole goal out to VoiceOver in one label', () => {
    const r = renderComponent(<GoalBanner goal={goal()} onPress={vi.fn()} />)
    expect(r.root.findByType('Pressable' as never).props.accessibilityLabel).toBe(
      'Goal: All tests pass and lint is clean. Active.',
    )
  })
})

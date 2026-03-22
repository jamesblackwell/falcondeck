import { describe, it, expect, beforeEach } from 'vitest'

import { useUIStore } from './ui-store'

describe('ui-store', () => {
  beforeEach(() => {
    // Reset to initial state
    useUIStore.setState({
      draft: '',
      selectedProvider: null,
      selectedModel: null,
      selectedEffort: 'medium',
      selectedCollaborationMode: null,
      isSubmitting: false,
    })
  })

  it('sets and clears draft text', () => {
    const { setDraft, clearDraft } = useUIStore.getState()

    setDraft('Hello world')
    expect(useUIStore.getState().draft).toBe('Hello world')

    clearDraft()
    expect(useUIStore.getState().draft).toBe('')
  })

  it('sets selected model', () => {
    useUIStore.getState().setSelectedModel('claude-opus-4-6')
    expect(useUIStore.getState().selectedModel).toBe('claude-opus-4-6')

    useUIStore.getState().setSelectedModel(null)
    expect(useUIStore.getState().selectedModel).toBeNull()
  })

  it('sets selected reasoning effort', () => {
    useUIStore.getState().setSelectedEffort('high')
    expect(useUIStore.getState().selectedEffort).toBe('high')
  })

  it('sets selected collaboration mode', () => {
    useUIStore.getState().setSelectedCollaborationMode('pair')
    expect(useUIStore.getState().selectedCollaborationMode).toBe('pair')
  })

  it('tracks submission state', () => {
    const { setIsSubmitting } = useUIStore.getState()

    expect(useUIStore.getState().isSubmitting).toBe(false)

    setIsSubmitting(true)
    expect(useUIStore.getState().isSubmitting).toBe(true)

    setIsSubmitting(false)
    expect(useUIStore.getState().isSubmitting).toBe(false)
  })

  it('defaults reasoning effort to medium', () => {
    expect(useUIStore.getState().selectedEffort).toBe('medium')
  })

  it('sets selected provider', () => {
    useUIStore.getState().setSelectedProvider('claude')
    expect(useUIStore.getState().selectedProvider).toBe('claude')

    useUIStore.getState().setSelectedProvider(null)
    expect(useUIStore.getState().selectedProvider).toBeNull()
  })
})

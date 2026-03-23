import { describe, it, expect, beforeEach } from 'vitest'

import { useUIStore } from './ui-store'

describe('ui-store', () => {
  beforeEach(() => {
    // Reset to initial state
    useUIStore.setState({
      draft: '',
      attachments: [],
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

  it('adds, sets, removes, and clears attachments', () => {
    const first = { type: 'image', id: 'img-1', name: 'one.png', mime_type: 'image/png', url: 'data:image/png;base64,one' } as const
    const second = { type: 'image', id: 'img-2', name: 'two.png', mime_type: 'image/png', url: 'data:image/png;base64,two' } as const
    const { addAttachments, clearAttachments, removeAttachment, setAttachments } = useUIStore.getState()

    addAttachments([first])
    expect(useUIStore.getState().attachments).toEqual([first])

    setAttachments([first, second])
    expect(useUIStore.getState().attachments).toEqual([first, second])

    removeAttachment('img-1')
    expect(useUIStore.getState().attachments).toEqual([second])

    clearAttachments()
    expect(useUIStore.getState().attachments).toEqual([])
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

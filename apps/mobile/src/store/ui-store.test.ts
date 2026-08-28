import { describe, it, expect, beforeEach, vi } from 'vitest'
import { draftKeyFor } from '@falcondeck/client-core'

import { storage } from '@/storage/mmkv'

import { flushStoredDrafts, useUIStore } from './ui-store'

const DRAFTS_STORAGE_KEY = 'falcondeck.mobile.composer-drafts.v1'

describe('ui-store', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // Drop any draft burst left pending by an earlier test.
    flushStoredDrafts()
    // Reset to initial state
    useUIStore.setState({
      conversationKey: draftKeyFor(null, null),
      drafts: {},
      attachmentsByConversation: {},
      draft: '',
      attachments: [],
      selectedProvider: null,
      selectedModel: null,
      selectedEffort: 'medium',
      persistedComposerSelections: {},
      pendingSubmissions: {},
      inFlightSubmissions: {},
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

  it('tracks submission state', () => {
    const { setIsSubmitting } = useUIStore.getState()

    expect(useUIStore.getState().isSubmitting).toBe(false)

    setIsSubmitting(true)
    expect(useUIStore.getState().isSubmitting).toBe(true)

    setIsSubmitting(false)
    expect(useUIStore.getState().isSubmitting).toBe(false)
  })

  it('scopes concurrent submission state to its owning conversation', () => {
    const { setConversation, setIsSubmitting } = useUIStore.getState()
    const firstKey = draftKeyFor('w1', 't1')
    const secondKey = draftKeyFor('w1', 't2')

    setConversation('w1', 't1')
    setIsSubmitting(true, firstKey)
    expect(useUIStore.getState().isSubmitting).toBe(true)

    setConversation('w1', 't2')
    expect(useUIStore.getState().isSubmitting).toBe(false)
    setIsSubmitting(true, secondKey)
    setIsSubmitting(false, firstKey)
    expect(useUIStore.getState().isSubmitting).toBe(true)

    setConversation('w1', 't1')
    expect(useUIStore.getState().isSubmitting).toBe(false)
    setConversation('w1', 't2')
    expect(useUIStore.getState().isSubmitting).toBe(true)
  })

  it('stores a branch composer without overwriting the selected conversation', () => {
    const branchImage = {
      type: 'image',
      id: 'branch-image',
      name: 'branch.png',
      mime_type: 'image/png',
      url: 'data:image/png;base64,branch',
    } as const
    const { setComposerForConversation, setConversation, setDraft } =
      useUIStore.getState()

    setConversation('w1', 'current')
    setDraft('Keep this draft')
    setComposerForConversation(
      draftKeyFor('w1', 'branch'),
      'Edit this branch',
      [branchImage],
    )

    expect(useUIStore.getState().draft).toBe('Keep this draft')
    expect(useUIStore.getState().attachments).toEqual([])
    setConversation('w1', 'branch')
    expect(useUIStore.getState().draft).toBe('Edit this branch')
    expect(useUIStore.getState().attachments).toEqual([branchImage])
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

  it('keeps a separate draft per conversation', () => {
    const { setDraft, setConversation } = useUIStore.getState()

    setConversation('w1', null)
    setDraft('new thread text')

    setConversation('w1', 't1')
    expect(useUIStore.getState().draft).toBe('')
    setDraft('thread one text')

    setConversation('w1', null)
    expect(useUIStore.getState().draft).toBe('new thread text')

    setConversation('w1', 't1')
    expect(useUIStore.getState().draft).toBe('thread one text')
  })

  it('ignores a conversation change to the same key', () => {
    const { setConversation, setDraft } = useUIStore.getState()
    setConversation('w1', 't1')
    setDraft('text')
    setConversation('w1', 't1')
    expect(useUIStore.getState().draft).toBe('text')
  })

  it('clears only the current conversation draft', () => {
    const { clearDraft, setConversation, setDraft } = useUIStore.getState()

    setConversation('w1', 't1')
    setDraft('one')
    setConversation('w1', 't2')
    setDraft('two')

    clearDraft()
    expect(useUIStore.getState().draft).toBe('')
    expect(useUIStore.getState().drafts[draftKeyFor('w1', 't2')]).toBeUndefined()

    setConversation('w1', 't1')
    expect(useUIStore.getState().draft).toBe('one')
  })

  it('keeps attachments with their conversation', () => {
    const image = { type: 'image', id: 'img-1', name: 'one.png', mime_type: 'image/png', url: 'data:image/png;base64,one' } as const
    const { addAttachments, setConversation } = useUIStore.getState()

    setConversation('w1', 't1')
    addAttachments([image])

    setConversation('w1', 't2')
    expect(useUIStore.getState().attachments).toEqual([])

    setConversation('w1', 't1')
    expect(useUIStore.getState().attachments).toEqual([image])
  })

  it('restores a failed submission without overwriting newer composer input', () => {
    const failedImage = { type: 'image', id: 'img-1', name: 'failed.png', mime_type: 'image/png', url: 'data:image/png;base64,failed' } as const
    const newerImage = { type: 'image', id: 'img-2', name: 'newer.png', mime_type: 'image/png', url: 'data:image/png;base64,newer' } as const
    const { restoreFailedSubmission, setAttachments, setConversation, setDraft } =
      useUIStore.getState()

    setConversation('w1', 't1')
    setDraft('New draft')
    setAttachments([newerImage])
    restoreFailedSubmission(draftKeyFor('w1', 't1'), 'Failed message', [failedImage])

    expect(useUIStore.getState().draft).toBe('Failed message\n\nNew draft')
    expect(useUIStore.getState().attachments).toEqual([failedImage, newerImage])
  })

  it('restores to a background conversation without changing the visible composer', () => {
    const { restoreFailedSubmission, setConversation, setDraft } = useUIStore.getState()
    setConversation('w1', 'visible')
    setDraft('Visible draft')

    restoreFailedSubmission(draftKeyFor('w1', 'failed'), 'Failed elsewhere', [])

    expect(useUIStore.getState().draft).toBe('Visible draft')
    expect(useUIStore.getState().drafts[draftKeyFor('w1', 'failed')]?.text).toBe(
      'Failed elsewhere',
    )
  })

  it('persists drafts to storage and tolerates write failures', () => {
    const { setDraft } = useUIStore.getState()

    setDraft('saved text')
    expect(storage.getString('falcondeck.mobile.composer-drafts.v1')).toContain('saved text')

    vi.spyOn(storage, 'set').mockImplementation(() => {
      throw new Error('disk full')
    })
    setDraft('still works in memory')
    expect(useUIStore.getState().draft).toBe('still works in memory')
    // Drop the burst state; pending writes are gone now.
    flushStoredDrafts()
  })

  it('commits the first keystroke of a burst immediately and coalesces the rest into one trailing write', () => {
    vi.useFakeTimers()
    try {
      const { setDraft, setConversation } = useUIStore.getState()
      setConversation('w1', 't1')

      setDraft('first')
      // Leading edge of the burst: persisted straight away.
      expect(storage.getString(DRAFTS_STORAGE_KEY)).toContain('first')

      setDraft('second')
      setDraft('third')
      // Still within the trailing window: only the newest value is queued,
      // and nothing further has been written.
      expect(storage.getString(DRAFTS_STORAGE_KEY)).not.toContain('second')
      expect(storage.getString(DRAFTS_STORAGE_KEY)).not.toContain('third')

      vi.advanceTimersByTime(299)
      expect(storage.getString(DRAFTS_STORAGE_KEY)).not.toContain('third')

      vi.advanceTimersByTime(1)
      // Trailing final flush carries the settled value.
      expect(storage.getString(DRAFTS_STORAGE_KEY)).toContain('third')
    } finally {
      vi.useRealTimers()
    }
  })

  it('flushes a queued draft burst on demand via flushStoredDrafts', () => {
    vi.useFakeTimers()
    try {
      const { setDraft, setConversation } = useUIStore.getState()
      setConversation('w1', 't1')
      setDraft('leading')
      setDraft('queued tail')

      expect(storage.getString(DRAFTS_STORAGE_KEY)).not.toContain('queued tail')
      flushStoredDrafts()
      expect(storage.getString(DRAFTS_STORAGE_KEY)).toContain('queued tail')

      // Nothing remains scheduled — flushing again is a no-op.
      vi.advanceTimersByTime(5_000)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('remembers picker selections per workspace and provider', () => {
    const { rememberComposerSelection, rememberWorkspaceProvider } = useUIStore.getState()

    rememberWorkspaceProvider('/repo', 'claude')
    rememberComposerSelection('/repo', 'claude', { permissionMode: 'bypassPermissions' })
    rememberComposerSelection('/repo', 'claude', { modelId: 'claude-fable-5' })

    const state = useUIStore.getState().persistedComposerSelections
    expect(state['/repo'].provider).toBe('claude')
    expect(state['/repo'].selections.claude).toEqual({
      modelId: 'claude-fable-5',
      effort: null,
      permissionMode: 'bypassPermissions',
      sandboxMode: null,
      serviceTier: null,
    })
    expect(storage.getString('falcondeck.mobile.composer-selections.v1')).toContain(
      'bypassPermissions',
    )
  })

  it('skips re-remembering the same workspace provider', () => {
    const { rememberWorkspaceProvider } = useUIStore.getState()
    rememberWorkspaceProvider('/repo', 'claude')
    const before = useUIStore.getState().persistedComposerSelections
    rememberWorkspaceProvider('/repo', 'claude')
    expect(useUIStore.getState().persistedComposerSelections).toBe(before)
  })

  it('tolerates selection write failures', () => {
    vi.spyOn(storage, 'set').mockImplementation(() => {
      throw new Error('disk full')
    })
    useUIStore.getState().rememberComposerSelection('/repo', 'codex', { effort: 'high' })
    expect(
      useUIStore.getState().persistedComposerSelections['/repo'].selections.codex?.effort,
    ).toBe('high')
  })
  it('empties a composer into the in-flight record and hands it back on failure', () => {
    const key = draftKeyFor('w1', 't1')
    const { beginSubmission, endSubmission, restoreFailedSubmission, setComposerForConversation } =
      useUIStore.getState()

    setComposerForConversation(key, 'Ship it', [])
    useUIStore.setState({ conversationKey: key, draft: 'Ship it' })

    beginSubmission(key, 'Ship it')
    expect(useUIStore.getState().draft).toBe('')
    expect(useUIStore.getState().drafts[key]).toBeUndefined()
    expect(useUIStore.getState().inFlightSubmissions[key]?.text).toBe('Ship it')
    // Persisted, so a process death mid-request still recovers the message.
    expect(storage.getString('falcondeck.mobile.composer-in-flight.v1')).toContain('Ship it')

    restoreFailedSubmission(key, 'Ship it', [])
    endSubmission(key)
    expect(useUIStore.getState().draft).toBe('Ship it')
    expect(useUIStore.getState().inFlightSubmissions[key]).toBeUndefined()
  })

  it('follows a send onto the thread the daemon created for it', () => {
    const newKey = draftKeyFor('w1', null)
    const threadKey = draftKeyFor('w1', 't-new')
    const { beginSubmission, moveSubmission } = useUIStore.getState()

    beginSubmission(newKey, 'Start this in a new thread')
    moveSubmission(newKey, threadKey)

    expect(useUIStore.getState().inFlightSubmissions[newKey]).toBeUndefined()
    expect(useUIStore.getState().inFlightSubmissions[threadKey]?.text).toBe(
      'Start this in a new thread',
    )
  })

  it('tolerates in-flight write failures', () => {
    vi.spyOn(storage, 'set').mockImplementation(() => {
      throw new Error('disk full')
    })
    useUIStore.getState().beginSubmission(draftKeyFor('w1', 't1'), 'Ship it')
    expect(useUIStore.getState().inFlightSubmissions[draftKeyFor('w1', 't1')]?.text).toBe('Ship it')
  })
})

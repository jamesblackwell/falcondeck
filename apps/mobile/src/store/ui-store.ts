import { create } from 'zustand'

import type { AgentProvider } from '@falcondeck/client-core'

interface UIState {
  draft: string
  selectedProvider: AgentProvider | null
  selectedModel: string | null
  selectedEffort: string | null
  selectedCollaborationMode: string | null
  isSubmitting: boolean
}

interface UIActions {
  setDraft: (draft: string) => void
  setSelectedProvider: (provider: AgentProvider | null) => void
  setSelectedModel: (modelId: string | null) => void
  setSelectedEffort: (effort: string | null) => void
  setSelectedCollaborationMode: (modeId: string | null) => void
  setIsSubmitting: (submitting: boolean) => void
  clearDraft: () => void
}

type UIStore = UIState & UIActions

export const useUIStore = create<UIStore>((set) => ({
  draft: '',
  selectedProvider: null,
  selectedModel: null,
  selectedEffort: 'medium',
  selectedCollaborationMode: null,
  isSubmitting: false,

  setDraft: (draft) => set({ draft }),
  setSelectedProvider: (provider) => set({ selectedProvider: provider }),
  setSelectedModel: (modelId) => set({ selectedModel: modelId }),
  setSelectedEffort: (effort) => set({ selectedEffort: effort }),
  setSelectedCollaborationMode: (modeId) => set({ selectedCollaborationMode: modeId }),
  setIsSubmitting: (submitting) => set({ isSubmitting: submitting }),
  clearDraft: () => set({ draft: '' }),
}))

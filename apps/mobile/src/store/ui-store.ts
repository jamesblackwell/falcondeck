import { create } from 'zustand'

interface UIState {
  draft: string
  selectedModel: string | null
  selectedEffort: string | null
  selectedCollaborationMode: string | null
  isSubmitting: boolean
}

interface UIActions {
  setDraft: (draft: string) => void
  setSelectedModel: (modelId: string | null) => void
  setSelectedEffort: (effort: string | null) => void
  setSelectedCollaborationMode: (modeId: string | null) => void
  setIsSubmitting: (submitting: boolean) => void
  clearDraft: () => void
}

type UIStore = UIState & UIActions

export const useUIStore = create<UIStore>((set) => ({
  draft: '',
  selectedModel: null,
  selectedEffort: 'medium',
  selectedCollaborationMode: null,
  isSubmitting: false,

  setDraft: (draft) => set({ draft }),
  setSelectedModel: (modelId) => set({ selectedModel: modelId }),
  setSelectedEffort: (effort) => set({ selectedEffort: effort }),
  setSelectedCollaborationMode: (modeId) => set({ selectedCollaborationMode: modeId }),
  setIsSubmitting: (submitting) => set({ isSubmitting: submitting }),
  clearDraft: () => set({ draft: '' }),
}))

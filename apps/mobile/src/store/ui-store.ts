import { create } from 'zustand'

import type { AgentProvider, ImageInput } from '@falcondeck/client-core'

interface UIState {
  draft: string
  attachments: ImageInput[]
  selectedProvider: AgentProvider | null
  selectedModel: string | null
  selectedEffort: string | null
  /** null means "no override" — the daemon keeps whatever the thread already has. */
  selectedPermissionMode: string | null
  selectedSandboxMode: string | null
  isSubmitting: boolean
}

interface UIActions {
  setDraft: (draft: string) => void
  setAttachments: (attachments: ImageInput[]) => void
  addAttachments: (attachments: ImageInput[]) => void
  removeAttachment: (attachmentId: string) => void
  setSelectedProvider: (provider: AgentProvider | null) => void
  setSelectedModel: (modelId: string | null) => void
  setSelectedEffort: (effort: string | null) => void
  setSelectedPermissionMode: (mode: string | null) => void
  setSelectedSandboxMode: (mode: string | null) => void
  setIsSubmitting: (submitting: boolean) => void
  clearAttachments: () => void
  clearDraft: () => void
}

type UIStore = UIState & UIActions

export const useUIStore = create<UIStore>((set) => ({
  draft: '',
  attachments: [],
  selectedProvider: null,
  selectedModel: null,
  selectedEffort: 'medium',
  selectedPermissionMode: null,
  selectedSandboxMode: null,
  isSubmitting: false,

  setDraft: (draft) => set({ draft }),
  setAttachments: (attachments) => set({ attachments }),
  addAttachments: (attachments) =>
    set((state) => ({ attachments: [...state.attachments, ...attachments] })),
  removeAttachment: (attachmentId) =>
    set((state) => ({
      attachments: state.attachments.filter((attachment) => attachment.id !== attachmentId),
    })),
  setSelectedProvider: (provider) => set({ selectedProvider: provider }),
  setSelectedModel: (modelId) => set({ selectedModel: modelId }),
  setSelectedEffort: (effort) => set({ selectedEffort: effort }),
  setSelectedPermissionMode: (mode) => set({ selectedPermissionMode: mode }),
  setSelectedSandboxMode: (mode) => set({ selectedSandboxMode: mode }),
  setIsSubmitting: (submitting) => set({ isSubmitting: submitting }),
  clearAttachments: () => set({ attachments: [] }),
  clearDraft: () => set({ draft: '' }),
}))

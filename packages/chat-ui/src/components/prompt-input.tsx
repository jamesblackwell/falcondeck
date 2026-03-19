import { ImagePlus, Map, Send } from 'lucide-react'
import { memo, useCallback, useRef, type ChangeEvent } from 'react'

import type {
  AgentProvider,
  CollaborationModeSummary,
  ImageInput,
  ModelSummary,
} from '@falcondeck/client-core'
import { Button } from '@falcondeck/ui'

import { ModelSelector, ProviderSelector, ReasoningSelector } from './model-selector'

export type PromptInputProps = {
  value: string
  onValueChange: (value: string) => void
  onSubmit: () => void
  onPickImages?: (files: FileList | null) => void
  attachments: ImageInput[]
  selectedProvider: AgentProvider
  onProviderChange: (value: AgentProvider) => void
  providerLocked?: boolean
  showProviderSelector?: boolean
  models: ModelSummary[]
  selectedModelId: string | null
  onModelChange: (value: string) => void
  reasoningOptions: string[]
  selectedEffort: string | null
  onEffortChange: (value: string) => void
  collaborationModes: CollaborationModeSummary[]
  selectedCollaborationModeId: string | null
  onCollaborationModeChange: (value: string) => void
  showPlanModeToggle?: boolean
  planModeEnabled?: boolean
  onPlanModeChange?: (enabled: boolean) => void
  disabled?: boolean
  compact?: boolean
}

export const PromptInput = memo(function PromptInput({
  value,
  onValueChange,
  onSubmit,
  onPickImages,
  attachments,
  selectedProvider,
  onProviderChange,
  providerLocked = false,
  showProviderSelector = true,
  models,
  selectedModelId,
  onModelChange,
  reasoningOptions,
  selectedEffort,
  onEffortChange,
  showPlanModeToggle = false,
  planModeEnabled = false,
  onPlanModeChange,
  disabled = false,
  compact = false,
}: PromptInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const canSubmit = (value.trim().length > 0 || attachments.length > 0) && !disabled

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    onPickImages?.(event.target.files)
    event.target.value = ''
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter') {
      if (event.metaKey || event.ctrlKey || event.shiftKey) {
        // Cmd/Ctrl+Enter or Shift+Enter → insert newline (default textarea behavior)
        return
      }
      // Plain Enter → submit
      event.preventDefault()
      if (canSubmit) {
        onSubmit()
      }
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const hasImage = Array.from(event.clipboardData.items).some(
      (item) => item.kind === 'file' && item.type.startsWith('image/'),
    )
    if (!hasImage) return
    event.preventDefault()
    onPickImages?.(event.clipboardData.files)
  }

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      onValueChange(event.target.value)
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.style.height = 'auto'
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`
      })
    },
    [onValueChange],
  )

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pt-2 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] md:mb-3 md:px-0 md:pt-0 md:pb-0">
      <div className="rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-2">
        {/* Attachment previews */}
        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2 border-b border-border-subtle px-4 py-3">
            {attachments.map((attachment) => (
              <img
                key={attachment.id}
                src={attachment.url}
                alt={attachment.name ?? 'attachment'}
                className="h-14 w-14 rounded-[var(--fd-radius-md)] border border-border-default object-cover"
              />
            ))}
          </div>
        ) : null}

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={disabled ? 'Add a project to get started...' : 'Ask your coding agent anything...'}
          className="block w-full resize-none bg-transparent px-4 pt-4 pb-3 text-[16px] leading-relaxed text-fg-primary placeholder:text-fg-secondary focus:outline-none md:text-[length:var(--fd-text-base)]"
          style={{ minHeight: '52px', maxHeight: '200px' }}
          rows={1}
        />

        {/* Footer: tools + send */}
        <div className="flex items-center gap-1.5 px-3 pb-3">
          <label className="inline-flex cursor-pointer">
            <input type="file" accept="image/*" multiple className="hidden" onChange={handleFileChange} />
            <span className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--fd-radius-md)] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary">
              <ImagePlus className="h-4 w-4" />
            </span>
          </label>

          {!compact ? (
            <>
              {showProviderSelector ? (
                <ProviderSelector
                  value={selectedProvider}
                  onValueChange={onProviderChange}
                  disabled={disabled || providerLocked}
                />
              ) : null}
              <ModelSelector value={selectedModelId} models={models} onValueChange={onModelChange} />
              <ReasoningSelector value={selectedEffort} options={reasoningOptions} onValueChange={onEffortChange} />
            </>
          ) : null}

          {showPlanModeToggle ? (
            <Button
              type="button"
              variant={planModeEnabled ? 'secondary' : 'ghost'}
              size="icon"
              disabled={disabled}
              onClick={() => onPlanModeChange?.(!planModeEnabled)}
              className="rounded-full"
              aria-pressed={planModeEnabled}
              title="Enable plan mode"
              aria-label="Enable plan mode"
            >
              <Map className="h-4 w-4" />
            </Button>
          ) : null}

          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              onClick={onSubmit}
              disabled={!canSubmit}
              className="h-9 w-9 rounded-full p-0"
            >
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
})

import { ImagePlus, Map, Send } from 'lucide-react'
import { memo, useCallback, useRef, type ChangeEvent } from 'react'

import type { CollaborationModeSummary, ImageInput, ModelSummary } from '@falcondeck/client-core'
import { Button } from '@falcondeck/ui'

import { ModelSelector, ReasoningSelector } from './model-selector'

export type PromptInputProps = {
  value: string
  onValueChange: (value: string) => void
  onSubmit: () => void
  onPickImages?: (files: FileList | null) => void
  attachments: ImageInput[]
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
      if (value.trim() && !disabled) {
        onSubmit()
      }
    }
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
    <div className="mx-auto mb-3 w-full max-w-3xl">
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
          placeholder={disabled ? 'Add a project to get started...' : 'Ask Codex anything...'}
          className="block w-full resize-none bg-transparent px-4 pt-4 pb-3 text-[length:var(--fd-text-base)] leading-relaxed text-fg-primary placeholder:text-fg-secondary focus:outline-none"
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
              disabled={disabled || !value.trim()}
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

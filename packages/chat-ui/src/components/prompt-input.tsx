import { ImagePlus, SendHorizonal } from 'lucide-react'
import type { ChangeEvent } from 'react'

import type { CollaborationModeSummary, ImageInput, ModelSummary } from '@falcondeck/client-core'
import { Button, Kbd } from '@falcondeck/ui'

import { CollaborationModeSelector, ModelSelector, ReasoningSelector } from './model-selector'

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
  disabled?: boolean
  approvalPolicy?: string | null
  compact?: boolean
}

export function PromptInput({
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
  collaborationModes,
  selectedCollaborationModeId,
  onCollaborationModeChange,
  disabled = false,
  compact = false,
}: PromptInputProps) {
  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    onPickImages?.(event.target.files)
    event.target.value = ''
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && value.trim() && !disabled) {
      event.preventDefault()
      onSubmit()
    }
  }

  function handleInput(event: React.ChangeEvent<HTMLTextAreaElement>) {
    const el = event.target
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
    onValueChange(el.value)
  }

  return (
    <div className="border-t border-border-subtle bg-surface-1">
      {/* Controls row */}
      <div className="flex items-center gap-2 px-4 py-2">
        <label className="inline-flex cursor-pointer">
          <input type="file" accept="image/*" multiple className="hidden" onChange={handleFileChange} />
          <span className="inline-flex h-7 w-7 items-center justify-center rounded-[var(--fd-radius-md)] text-fg-muted transition-colors hover:bg-surface-3 hover:text-fg-secondary">
            <ImagePlus className="h-4 w-4" />
          </span>
        </label>
        {!compact ? (
          <>
            <ModelSelector value={selectedModelId} models={models} onValueChange={onModelChange} />
            <ReasoningSelector value={selectedEffort} options={reasoningOptions} onValueChange={onEffortChange} />
            <CollaborationModeSelector value={selectedCollaborationModeId} modes={collaborationModes} onValueChange={onCollaborationModeChange} />
          </>
        ) : null}
      </div>

      {/* Attachment previews */}
      {attachments.length > 0 ? (
        <div className="flex flex-wrap gap-2 px-4 pb-2">
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

      {/* Textarea + send */}
      <div className="relative px-4 pb-3">
        <textarea
          value={value}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Ask Codex anything..."
          className="w-full resize-none bg-transparent py-2 pr-20 text-[length:var(--fd-text-base)] text-fg-primary placeholder:text-fg-muted focus:outline-none disabled:opacity-40"
          style={{ minHeight: '44px', maxHeight: '200px' }}
          disabled={disabled}
          rows={1}
        />
        <div className="absolute right-5 bottom-4 flex items-center gap-2">
          {!compact ? <Kbd>⌘↵</Kbd> : null}
          <Button
            type="button"
            size="icon"
            onClick={onSubmit}
            disabled={disabled || !value.trim()}
            className="h-7 w-7 rounded-full"
          >
            <SendHorizonal className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  )
}

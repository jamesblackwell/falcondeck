import { ImagePlus, SendHorizonal } from 'lucide-react'
import type { ChangeEvent } from 'react'

import type { CollaborationModeSummary, ImageInput, ModelSummary } from '@falcondeck/client-core'
import { Badge, Button, Card, CardContent, Textarea } from '@falcondeck/ui'

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
  approvalPolicy,
}: PromptInputProps) {
  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    onPickImages?.(event.target.files)
    event.target.value = ''
  }

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <Textarea
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder="Ask Codex anything, @ to add files, / for commands"
          className="min-h-[160px] resize-none border-none bg-transparent px-0 py-0 text-base focus-visible:ring-0"
          disabled={disabled}
        />

        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-3">
            {attachments.map((attachment) => (
              <img
                key={attachment.id}
                src={attachment.url}
                alt={attachment.name ?? 'attachment'}
                className="h-20 w-20 rounded-2xl border border-white/10 object-cover"
              />
            ))}
          </div>
        ) : null}

        <div className="flex flex-col gap-3 border-t border-white/10 pt-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex cursor-pointer">
              <input type="file" accept="image/*" multiple className="hidden" onChange={handleFileChange} />
              <span className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white transition hover:bg-white/10">
                <ImagePlus className="h-5 w-5" />
              </span>
            </label>
            <ModelSelector value={selectedModelId} models={models} onValueChange={onModelChange} />
            <ReasoningSelector
              value={selectedEffort}
              options={reasoningOptions}
              onValueChange={onEffortChange}
            />
            <CollaborationModeSelector
              value={selectedCollaborationModeId}
              modes={collaborationModes}
              onValueChange={onCollaborationModeChange}
            />
            <Badge>{approvalPolicy ?? 'on-request'}</Badge>
            <div className="ml-auto">
              <Button type="button" onClick={onSubmit} disabled={disabled || !value.trim()}>
                <SendHorizonal className="h-4 w-4" />
                Send
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

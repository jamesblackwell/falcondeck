import { ImagePlus, Map, Send, X } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'

import type {
  ActiveSlashQuery,
  AgentProvider,
  CollaborationModeSummary,
  ImageInput,
  ModelSummary,
  SkillSummary,
} from '@falcondeck/client-core'
import { activeSlashQuery, canonicalSkillAlias, providerSupportsSkill } from '@falcondeck/client-core'
import { Button } from '@falcondeck/ui'

import { ModelSelector, ProviderSelector, ReasoningSelector } from './model-selector'
import { attachmentLabel, canRenderAttachmentImage } from './attachment-preview'

export type PromptInputProps = {
  value: string
  onValueChange: (value: string) => void
  onSubmit: () => void
  onPickImages?: (files: FileList | null) => void
  onRemoveAttachment?: (attachmentId: string) => void
  attachments: ImageInput[]
  skills?: SkillSummary[]
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
  onRemoveAttachment,
  attachments,
  skills = [],
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
  const [slashQuery, setSlashQuery] = useState<ActiveSlashQuery | null>(null)
  const [activeSkillIndex, setActiveSkillIndex] = useState(0)
  const canSubmit = (value.trim().length > 0 || attachments.length > 0) && !disabled

  const filteredSkills = useMemo(() => {
    const query = slashQuery?.query.trim().toLowerCase() ?? ''
    const visibleSkills = skills.filter((skill) => {
      if (!query) return true
      return (
        canonicalSkillAlias(skill.alias).includes(`/${query}`) ||
        skill.label.toLowerCase().includes(query) ||
        (skill.description ?? '').toLowerCase().includes(query)
      )
    })

    return visibleSkills.sort((left, right) => {
      const leftSupported = providerSupportsSkill(left, selectedProvider)
      const rightSupported = providerSupportsSkill(right, selectedProvider)
      if (leftSupported !== rightSupported) {
        return leftSupported ? -1 : 1
      }
      return left.alias.localeCompare(right.alias)
    })
  }, [selectedProvider, skills, slashQuery?.query])

  useEffect(() => {
    setActiveSkillIndex(0)
  }, [slashQuery?.query])

  const activeSkill =
    filteredSkills.length > 0
      ? filteredSkills[Math.min(activeSkillIndex, filteredSkills.length - 1)] ?? null
      : null
  const activeSkillSupported = activeSkill ? providerSupportsSkill(activeSkill, selectedProvider) : false

  const updateSlashQuery = useCallback(
    (nextValue: string, caretIndex?: number | null) => {
      if (disabled) {
        setSlashQuery(null)
        return
      }
      const index =
        typeof caretIndex === 'number'
          ? caretIndex
          : textareaRef.current?.selectionStart ?? nextValue.length
      setSlashQuery(activeSlashQuery(nextValue, index))
    },
    [disabled],
  )

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    onPickImages?.(event.target.files)
    event.target.value = ''
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (slashQuery && filteredSkills.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setActiveSkillIndex((current) => (current + 1) % filteredSkills.length)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setActiveSkillIndex((current) => (current - 1 + filteredSkills.length) % filteredSkills.length)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setSlashQuery(null)
        return
      }
      if ((event.key === 'Tab' || event.key === 'Enter') && activeSkillSupported && activeSkill) {
          event.preventDefault()
          insertSkillAlias(activeSkill.alias)
          return
      }
    }
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
      const nextValue = event.target.value
      onValueChange(nextValue)
      updateSlashQuery(nextValue, event.target.selectionStart)
      requestAnimationFrame(() => {
        const el = textareaRef.current
        if (!el) return
        el.style.height = 'auto'
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`
      })
    },
    [onValueChange, updateSlashQuery],
  )

  const insertSkillAlias = useCallback(
    (alias: string) => {
      const query = slashQuery
      const textarea = textareaRef.current
      if (!query || !textarea) return
      const nextValue = `${value.slice(0, query.rangeStart)}${alias} ${value.slice(query.rangeEnd)}`
      const nextCaret = query.rangeStart + alias.length + 1
      onValueChange(nextValue)
      setSlashQuery(null)
      requestAnimationFrame(() => {
        textarea.focus()
        textarea.setSelectionRange(nextCaret, nextCaret)
        updateSlashQuery(nextValue, nextCaret)
      })
    },
    [onValueChange, slashQuery, updateSlashQuery, value],
  )

  return (
    <div className="mx-auto w-full max-w-3xl px-3 pt-2 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] md:mb-3 md:px-0 md:pt-0 md:pb-0">
      <div className="rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-2">
        {/* Attachment previews */}
        {attachments.length > 0 ? (
          <div className="flex flex-wrap gap-2 border-b border-border-subtle px-4 py-3">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="relative">
                {canRenderAttachmentImage(attachment.url) ? (
                  <img
                    src={attachment.url}
                    alt={attachment.name ?? 'attachment'}
                    className="h-14 w-14 rounded-[var(--fd-radius-md)] border border-border-default object-cover"
                  />
                ) : (
                  <div
                    className="flex h-14 w-28 items-center rounded-[var(--fd-radius-md)] border border-border-default bg-surface-2 px-2 text-[length:var(--fd-text-xs)] text-fg-secondary"
                    title={attachment.local_path ?? attachment.url}
                  >
                    <span className="truncate">{attachmentLabel(attachment)}</span>
                  </div>
                )}
                {onRemoveAttachment ? (
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment(attachment.id)}
                    disabled={disabled}
                    className="absolute -top-1.5 -right-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border-default bg-surface-3 text-fg-secondary shadow-sm transition-colors hover:bg-surface-4 hover:text-fg-primary disabled:pointer-events-none disabled:opacity-60"
                    aria-label={`Remove ${attachment.name ?? 'image attachment'}`}
                  >
                    <X className="h-3 w-3" />
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}

        {/* Textarea */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onClick={() => updateSlashQuery(value)}
          onKeyUp={() => updateSlashQuery(value)}
          onPaste={handlePaste}
          placeholder={disabled ? 'Add a project to get started...' : 'Ask your coding agent anything...'}
          className="block w-full resize-none bg-transparent px-4 pt-4 pb-3 text-[16px] leading-relaxed text-fg-primary placeholder:text-fg-secondary focus:outline-none md:text-[length:var(--fd-text-base)]"
          style={{ minHeight: '52px', maxHeight: '200px' }}
          rows={1}
        />

        {slashQuery && !disabled ? (
          <div className="mx-3 mb-2 overflow-hidden rounded-[var(--fd-radius-lg)] border border-border-default bg-surface-1 shadow-lg">
            {filteredSkills.length > 0 ? (
              <div className="max-h-64 overflow-y-auto py-1">
                {filteredSkills.map((skill, index) => {
                  const supported = providerSupportsSkill(skill, selectedProvider)
                  const active = index === activeSkillIndex
                  return (
                    <button
                      key={skill.id}
                      type="button"
                      disabled={!supported}
                      onMouseDown={(event) => {
                        event.preventDefault()
                        if (supported) {
                          insertSkillAlias(skill.alias)
                        }
                      }}
                      className={`flex w-full items-start gap-3 px-3 py-2 text-left transition-colors ${
                        active ? 'bg-surface-3' : 'hover:bg-surface-2'
                      } ${supported ? 'text-fg-primary' : 'cursor-not-allowed text-fg-muted opacity-70'}`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-[length:var(--fd-text-sm)]">
                          <span className="font-medium">{skill.alias}</span>
                          <span className="rounded-full border border-border-subtle px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-fg-muted">
                            {skill.availability}
                          </span>
                          <span className="rounded-full border border-border-subtle px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-fg-muted">
                            {skill.source_kind.replace('_', ' ')}
                          </span>
                        </div>
                        <div className="truncate text-[length:var(--fd-text-xs)] text-fg-secondary">
                          {skill.description ?? skill.label}
                        </div>
                      </div>
                      {!supported ? (
                        <span className="shrink-0 text-[length:var(--fd-text-xs)] text-fg-muted">
                          {selectedProvider} only unavailable
                        </span>
                      ) : null}
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="px-3 py-2 text-[length:var(--fd-text-sm)] text-fg-muted">
                No skills match <span className="font-medium">/{slashQuery.query}</span>
              </div>
            )}
          </div>
        ) : null}

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

import { ImagePlus, Plug, Send, Square, X } from 'lucide-react'
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'

import type {
  ActiveSlashQuery,
  AgentCapabilitySummary,
  AgentProvider,
  ImageInput,
  ModelSummary,
  ProviderOption,
  SkillSummary,
  ThreadIsolation,
} from '@falcondeck/client-core'
import {
  activeSlashQuery,
  anyModelHasFastTier,
  canonicalSkillAlias,
  modelFastTier,
  NO_AGENT_CAPABILITIES,
  providerSupportsSkill,
  resolveServiceTier,
} from '@falcondeck/client-core'
import { Button, cn } from '@falcondeck/ui'

import {
  FastModeToggle,
  IsolationSelector,
  ModelSelector,
  PermissionModeSelector,
  ProviderSelector,
  ReasoningSelector,
  SandboxSelector,
} from './model-selector'
import { attachmentLabel, canRenderAttachmentImage } from './attachment-preview'

export type PromptInputProps = {
  value: string
  onValueChange: (value: string) => void
  onSubmit: () => void
  /** Interrupt the active turn. When set and the thread is running with an empty draft, the primary button becomes Stop. */
  onStop?: () => void
  onPickImages?: (files: FileList | null) => void
  onRemoveAttachment?: (attachmentId: string) => void
  attachments: ImageInput[]
  skills?: SkillSummary[]
  selectedProvider: AgentProvider
  onProviderChange: (value: AgentProvider) => void
  /** Providers the active workspace offers; defaults to the built-in pair. */
  providers?: ProviderOption[]
  /** Capabilities of the active provider; gates the mode pickers. */
  capabilities?: AgentCapabilitySummary
  providerLocked?: boolean
  showProviderSelector?: boolean
  models: ModelSummary[]
  selectedModelId: string | null
  onModelChange: (value: string) => void
  reasoningOptions: string[]
  selectedEffort: string | null
  onEffortChange: (value: string) => void
  /**
   * Service tier id when fast mode is on; null runs the standard tier. The
   * toggle only mounts when a model of the current provider advertises a tier
   * and a handler is passed, so providers without the concept keep a clean row.
   */
  selectedServiceTier?: string | null
  onServiceTierChange?: (value: string | null) => void
  selectedPermissionMode?: string | null
  onPermissionModeChange?: (value: string | null) => void
  selectedSandboxMode?: string | null
  onSandboxModeChange?: (value: string | null) => void
  /**
   * Isolation for the thread this composer will create. Omitting the handler
   * hides the control — mid-thread it has nothing to change, because a
   * thread's working directory is fixed when it is created.
   */
  selectedIsolation?: ThreadIsolation
  onIsolationChange?: (value: ThreadIsolation) => void
  disabled?: boolean
  sendDisabled?: boolean
  /** True while the selected thread has an in-flight turn. */
  isRunning?: boolean
  /** True while an interrupt request is in flight. */
  isStopping?: boolean
  compact?: boolean
  /** Enabled MCP servers for this workspace; renders a tools chip when > 0. */
  connectorCount?: number
  onConnectorsClick?: () => void
}

const PROMPT_INPUT_MIN_HEIGHT = 52
const PROMPT_INPUT_MAX_HEIGHT = 200

const DEFAULT_PROVIDER_OPTIONS: ProviderOption[] = [
  { provider: 'codex', label: 'Codex' },
  { provider: 'claude', label: 'Claude' },
]

/** Keeps a disabled picker mounted when the host passes no handler for it. */
const noopModeChange = () => {}

export const PromptInput = memo(function PromptInput({
  value,
  onValueChange,
  onSubmit,
  onStop,
  onPickImages,
  onRemoveAttachment,
  attachments,
  skills = [],
  selectedProvider,
  onProviderChange,
  providers = DEFAULT_PROVIDER_OPTIONS,
  capabilities = NO_AGENT_CAPABILITIES,
  providerLocked = false,
  showProviderSelector = true,
  models,
  selectedModelId,
  onModelChange,
  reasoningOptions,
  selectedEffort,
  onEffortChange,
  selectedServiceTier = null,
  onServiceTierChange,
  selectedPermissionMode = null,
  onPermissionModeChange,
  selectedSandboxMode = null,
  onSandboxModeChange,
  selectedIsolation = 'project_folder',
  onIsolationChange,
  disabled = false,
  sendDisabled = false,
  isRunning = false,
  isStopping = false,
  compact = false,
  connectorCount = 0,
  onConnectorsClick,
}: PromptInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [slashQuery, setSlashQuery] = useState<ActiveSlashQuery | null>(null)
  const [activeSkillIndex, setActiveSkillIndex] = useState(0)
  const hasContent = value.trim().length > 0 || attachments.length > 0
  const canSubmit = hasContent && !disabled && !sendDisabled
  // Stop when a turn is running and there's nothing to send yet. Typing a follow-up
  // keeps Send so a later queue/steer path can use it; empty draft is the stop case.
  const showStop =
    Boolean(onStop) &&
    isRunning &&
    !hasContent &&
    capabilities.supports_interrupt
  // Fast mode reads the tier off whichever model a send would actually use —
  // the explicit pick, or the provider default while nothing is picked yet.
  const selectedModel =
    models.find((model) => model.id === selectedModelId) ??
    models.find((model) => model.is_default) ??
    null

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

  const syncTextareaHeight = useCallback((element: HTMLTextAreaElement | null) => {
    if (!element) return
    element.style.height = 'auto'
    element.style.height = `${Math.min(element.scrollHeight, PROMPT_INPUT_MAX_HEIGHT)}px`
  }, [])

  useLayoutEffect(() => {
    syncTextareaHeight(textareaRef.current)
  }, [syncTextareaHeight, value])

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
      syncTextareaHeight(event.target)
    },
    [onValueChange, syncTextareaHeight, updateSlashQuery],
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
    <div className="mx-auto w-full max-w-3xl px-3 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] md:mb-4 md:px-6 md:pt-3 md:pb-0">
      <div className="rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-2 shadow-[0_-8px_24px_-12px_rgba(0,0,0,0.35)]">
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
                    className="fd-focus absolute -top-1.5 -right-1.5 inline-flex h-5 w-5 items-center justify-center rounded-full border border-border-default bg-surface-3 text-fg-secondary shadow-sm transition-colors hover:bg-surface-4 hover:text-fg-primary disabled:pointer-events-none disabled:opacity-60"
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
          placeholder={disabled ? 'Add a project to get started...' : 'Ask anything'}
          /* 16px on small screens keeps iOS Safari from zooming in on focus;
             drops to the standard body size once there is room. */
          className="block w-full resize-none bg-transparent px-4 pt-4 pb-3 text-[length:var(--fd-text-md)] leading-relaxed text-fg-primary placeholder:text-fg-muted focus:outline-none md:text-[length:var(--fd-text-base)]"
          style={{ minHeight: `${PROMPT_INPUT_MIN_HEIGHT}px`, maxHeight: `${PROMPT_INPUT_MAX_HEIGHT}px` }}
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
                          <span className="rounded-full border border-border-subtle px-2 py-0.5 text-[length:var(--fd-text-2xs)] uppercase tracking-[0.18em] text-fg-muted">
                            {skill.providers.join(' / ')}
                          </span>
                          <span className="rounded-full border border-border-subtle px-2 py-0.5 text-[length:var(--fd-text-2xs)] uppercase tracking-[0.18em] text-fg-muted">
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

          {/* Capability → mode → model → effort → switches. Permission scope
              leads because it is the toggle with consequences. */}
          {!compact ? (
            <>
              {showProviderSelector ? (
                <ProviderSelector
                  value={selectedProvider}
                  providers={providers}
                  onValueChange={onProviderChange}
                  disabled={disabled || providerLocked}
                />
              ) : null}
              <PermissionModeSelector
                value={selectedPermissionMode}
                modes={capabilities.permission_modes}
                onValueChange={onPermissionModeChange ?? noopModeChange}
                disabled={disabled || !onPermissionModeChange}
              />
              <SandboxSelector
                value={selectedSandboxMode}
                modes={capabilities.sandbox_modes}
                onValueChange={onSandboxModeChange ?? noopModeChange}
                disabled={disabled || !onSandboxModeChange}
              />
              <ModelSelector
                value={selectedModelId}
                models={models}
                onValueChange={onModelChange}
                disabled={disabled || models.length === 0}
              />
              <ReasoningSelector
                value={selectedEffort}
                options={reasoningOptions}
                onValueChange={onEffortChange}
                disabled={disabled || reasoningOptions.length === 0}
              />
              {onServiceTierChange && anyModelHasFastTier(models) ? (
                <FastModeToggle
                  tier={modelFastTier(selectedModel)}
                  active={resolveServiceTier(selectedServiceTier, selectedModel) !== null}
                  onActiveChange={(active) =>
                    onServiceTierChange(active ? (modelFastTier(selectedModel)?.id ?? null) : null)
                  }
                  disabled={disabled}
                />
              ) : null}
              {onIsolationChange ? (
                <IsolationSelector
                  value={selectedIsolation}
                  onValueChange={onIsolationChange}
                  disabled={disabled}
                />
              ) : null}
            </>
          ) : null}

          {!compact && connectorCount > 0 ? (
            <button
              type="button"
              onClick={onConnectorsClick}
              disabled={!onConnectorsClick}
              title={`${connectorCount} MCP server${connectorCount === 1 ? '' : 's'} available to agents in this workspace`}
              className={cn(
                'flex items-center gap-1 rounded-full border border-border-subtle px-2 py-1 text-[length:var(--fd-text-xs)] text-fg-muted',
                onConnectorsClick && 'hover:border-border-emphasis hover:text-fg-secondary',
              )}
            >
              <Plug className="h-3 w-3" aria-hidden="true" />
              {connectorCount}
            </button>
          ) : null}

          <div className="ml-auto flex items-center gap-2">
            {showStop ? (
              <Button
                type="button"
                onClick={onStop}
                disabled={disabled || isStopping}
                aria-label={isStopping ? 'Stopping' : 'Stop generating'}
                title={isStopping ? 'Stopping…' : 'Stop'}
                className="h-9 w-9 rounded-full p-0"
              >
                <Square className="h-3.5 w-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                type="button"
                onClick={onSubmit}
                disabled={!canSubmit}
                aria-label="Send message"
                className="h-9 w-9 rounded-full p-0"
              >
                <Send className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
})

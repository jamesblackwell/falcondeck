import { memo, useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import { ArrowLeft, Check, Pencil, RotateCcw, Save, X } from 'lucide-react'

import { HighlightedFileLine, languageFromPath, useShikiTokens } from '@falcondeck/chat-ui'
import type { WorkspaceFileResponse } from '@falcondeck/client-core'
import { ActivityDiamond, Button, Tooltip } from '@falcondeck/ui'

import { FileTypeIcon } from './FileTypeIcon'

export const FileView = memo(function FileView({
  filePath,
  file,
  isLoading,
  isSaving,
  error,
  onBack,
  onReload,
  onSave,
}: {
  filePath: string
  file: WorkspaceFileResponse | null
  isLoading: boolean
  isSaving: boolean
  error: string | null
  onBack: () => void
  onReload: () => void
  onSave: (content: string) => Promise<boolean>
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState('')
  useEffect(() => {
    setDraft(file?.content ?? '')
    setIsEditing(false)
  }, [file?.content, filePath])

  const lines = useMemo(() => (file?.content ?? '').replace(/\r\n/g, '\n').split('\n'), [file?.content])
  const language = useMemo(() => languageFromPath(filePath), [filePath])
  // Keep very large source files readable without sending thousands of lines
  // through the syntax highlighter on open.
  const tokens = useShikiTokens(
    !isEditing && file?.content != null && lines.length <= 2_000 ? lines : [],
    language,
  )
  const isDirty = file?.content != null && draft !== file.content

  const save = async () => {
    if (!isDirty) {
      setIsEditing(false)
      return
    }
    if (await onSave(draft)) setIsEditing(false)
  }

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault()
      void save()
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 items-center gap-2 border-b border-border-subtle px-3">
        <Button type="button" variant="ghost" size="icon" onClick={onBack} aria-label="Back to files" className="-ml-1 shrink-0">
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
        </Button>
        <FileTypeIcon path={filePath} />
        <p className="min-w-0 flex-1 truncate text-[length:var(--fd-text-xs)] font-medium text-fg-primary">
          {filePath}
        </p>
        {file?.content != null && !file.truncated && !file.is_binary ? (
          isEditing ? (
            <>
              <Tooltip label="Cancel">
                <button
                  type="button"
                  onClick={() => {
                    setDraft(file.content ?? '')
                    setIsEditing(false)
                  }}
                  aria-label="Cancel editing"
                  className="fd-focus rounded-[var(--fd-radius-sm)] p-1 text-fg-muted hover:bg-surface-3 hover:text-fg-secondary"
                >
                  <X aria-hidden="true" className="h-3.5 w-3.5" />
                </button>
              </Tooltip>
              <Tooltip label="Save file" shortcut={['⌘', 'S']}>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={isSaving || !isDirty}
                  aria-label="Save file"
                  className="fd-focus rounded-[var(--fd-radius-sm)] p-1 text-accent hover:bg-accent-muted disabled:text-fg-faint"
                >
                {isSaving ? (
                  <ActivityDiamond tone="current" />
                ) : isDirty ? (
                  <Save aria-hidden="true" className="h-3.5 w-3.5" />
                ) : (
                  <Check aria-hidden="true" className="h-3.5 w-3.5" />
                )}
                </button>
              </Tooltip>
            </>
          ) : (
            <Tooltip label="Edit file">
              <button
                type="button"
                onClick={() => setIsEditing(true)}
                aria-label="Edit file"
                className="fd-focus rounded-[var(--fd-radius-sm)] p-1 text-fg-muted hover:bg-surface-3 hover:text-fg-secondary"
              >
                <Pencil aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </Tooltip>
          )
        ) : null}
        <button
          type="button"
          onClick={onReload}
          disabled={isLoading}
          aria-label="Reload file"
          className="fd-focus rounded-[var(--fd-radius-sm)] p-1 text-fg-muted hover:bg-surface-3 hover:text-fg-secondary disabled:opacity-40"
        >
          {isLoading ? (
            <ActivityDiamond tone="current" />
          ) : (
            <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
          )}
        </button>
      </div>

      {error ? (
        <div className="border-b border-danger/30 bg-danger-muted px-3 py-2 text-[length:var(--fd-text-xs)] text-danger">
          {error}
        </div>
      ) : null}
      <div className="min-h-0 flex-1 overflow-auto">
        {isLoading ? (
          <ActivityDiamond size="lg" className="mx-auto mt-8 flex" />
        ) : file?.is_binary ? (
          <div className="p-4 text-center text-[length:var(--fd-text-xs)] text-fg-muted">
            Binary files cannot be displayed
          </div>
        ) : file?.truncated ? (
          <div className="p-4 text-center text-[length:var(--fd-text-xs)] text-fg-muted">
            File is larger than the 1 MB viewer limit
          </div>
        ) : isEditing ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleEditorKeyDown}
            spellCheck={false}
            aria-label={`Edit ${filePath}`}
            className="h-full min-h-full w-full resize-none bg-surface-0 p-3 font-mono text-[length:var(--fd-text-2xs)] leading-5 text-fg-primary outline-none"
          />
        ) : file?.content != null ? (
          <div className="font-mono text-[length:var(--fd-text-2xs)] leading-5">
            {lines.map((line, index) => (
              <HighlightedFileLine
                key={index}
                lineNumber={index + 1}
                text={line}
                tokens={tokens?.[index] ?? null}
              />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
})

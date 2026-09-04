import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowLeft, Check, Copy, Pencil, RotateCcw, Save, X } from 'lucide-react'

import { HighlightedFileLine, languageFromPath, useShikiTokens } from '@falcondeck/chat-ui'
import { formatArtifactSize, type WorkspaceFileResponse } from '@falcondeck/client-core'
import { ActivityDiamond, Button, Tooltip } from '@falcondeck/ui'

import { basePart, dirPart } from './diff-utils'
import { FileTypeIcon } from './FileTypeIcon'
import {
  FilePreviewToggle,
  MarkdownFileDocument,
  shouldPreviewMarkdown,
  useMarkdownPreviewMode,
} from './markdown-file'
import {
  MAX_MEDIA_PREVIEW_BYTES,
  MediaFilePreview,
  mediaKindFromMime,
  mediaKindFromPath,
  mimeTypeFromPath,
  shouldPreviewSvg,
  useMediaObjectUrl,
} from './media-file'

export const FileView = memo(function FileView({
  filePath,
  line = null,
  file,
  isLoading,
  isSaving,
  error,
  onBack,
  onReload,
  onSave,
}: {
  filePath: string
  /** Line to scroll into view and highlight, e.g. from a `path:12` citation. */
  line?: number | null
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
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const targetLine = line != null && line >= 1 && line <= lines.length ? line : null
  // Scroll once the requested line has rendered; a later click on the same
  // file with a new line re-runs this without remounting the viewer.
  useEffect(() => {
    if (targetLine == null || file?.content == null) return
    const row = scrollRef.current?.querySelector<HTMLElement>(
      `[data-line="${targetLine}"]`,
    )
    row?.scrollIntoView({ block: 'center' })
  }, [file?.content, targetLine])
  const language = useMemo(() => languageFromPath(filePath), [filePath])
  const mediaKind =
    mediaKindFromMime(file?.mime_type) ?? mediaKindFromPath(filePath)
  const mediaMime = file?.mime_type ?? mimeTypeFromPath(filePath)
  const canPreviewSvg = shouldPreviewSvg(filePath, file?.content)
  const canPreviewMarkdown = shouldPreviewMarkdown(filePath, file?.content)
  const canTogglePreview = canPreviewMarkdown || canPreviewSvg
  const { mode, setMode, showPreview } = useMarkdownPreviewMode(filePath, canTogglePreview)
  const mediaUrl = useMediaObjectUrl(
    file?.content_base64,
    mediaMime,
    canPreviewSvg ? file?.content : null,
  )
  const expectingMedia =
    mediaKind != null &&
    mediaMime != null &&
    !file?.truncated &&
    (Boolean(file?.content_base64) || canPreviewSvg)
  const showMedia =
    !isEditing &&
    expectingMedia &&
    mediaUrl != null &&
    (!canPreviewSvg || showPreview)
  const waitingForMedia =
    expectingMedia && mediaUrl == null && (!canPreviewSvg || showPreview) && !isEditing
  const fileName = useMemo(() => basePart(filePath), [filePath])
  const directory = useMemo(() => dirPart(filePath), [filePath])
  const [copiedPath, setCopiedPath] = useState(false)
  useEffect(() => {
    if (!copiedPath) return
    const timer = window.setTimeout(() => setCopiedPath(false), 1200)
    return () => window.clearTimeout(timer)
  }, [copiedPath])
  const copyPath = () => {
    void navigator.clipboard.writeText(filePath).then(
      () => setCopiedPath(true),
      () => {},
    )
  }
  const lineCount = isEditing
    ? draft.replace(/\r\n/g, '\n').split('\n').length
    : file?.content != null
      ? lines.length
      : null
  const sizeLabel = formatArtifactSize(file?.size_bytes)
  const textStatus = [
    lineCount != null ? `${lineCount} ${lineCount === 1 ? 'line' : 'lines'}` : null,
    sizeLabel,
  ]
    .filter((fact): fact is string => Boolean(fact))
    .join(' · ')
  // Keep very large source files readable without sending thousands of lines
  // through the syntax highlighter on open.
  const tokens = useShikiTokens(
    !isEditing && !showPreview && file?.content != null && lines.length <= 2_000 ? lines : [],
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
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border-subtle px-3">
        <Button type="button" variant="ghost" size="icon" onClick={onBack} aria-label="Back to files" className="-ml-1 shrink-0">
          <ArrowLeft aria-hidden="true" className="h-4 w-4" />
        </Button>
        <FileTypeIcon path={filePath} />
        <p
          title={filePath}
          className="min-w-0 flex-1 truncate text-[length:var(--fd-text-xs)] text-fg-primary"
        >
          {directory ? <span className="text-fg-muted">{directory}</span> : null}
          <span className="font-medium">{fileName}</span>
        </p>
        <Tooltip label={copiedPath ? 'Copied' : 'Copy path'}>
          <button
            type="button"
            onClick={copyPath}
            aria-label="Copy path"
            className="fd-focus rounded-[var(--fd-radius-sm)] p-1 text-fg-muted hover:bg-surface-3 hover:text-fg-secondary"
          >
            {copiedPath ? (
              <Check aria-hidden="true" className="h-3.5 w-3.5 text-accent" />
            ) : (
              <Copy aria-hidden="true" className="h-3.5 w-3.5" />
            )}
          </button>
        </Tooltip>
        {canTogglePreview && !isEditing ? (
          <FilePreviewToggle mode={mode} onChange={setMode} />
        ) : null}
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
      <div
        ref={scrollRef}
        className={`min-h-0 flex-1 ${showMedia || waitingForMedia ? 'overflow-hidden' : 'overflow-auto'}`}
      >
        {isLoading || waitingForMedia ? (
          <ActivityDiamond size="lg" className="mx-auto mt-8 flex" />
        ) : showMedia && mediaKind && mediaUrl ? (
          <MediaFilePreview
            kind={mediaKind}
            src={mediaUrl}
            fileName={fileName}
            sizeBytes={file?.size_bytes}
          />
        ) : file?.truncated ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
            <p className="text-[length:var(--fd-text-xs)] text-fg-secondary">This file is too large to preview</p>
            <p className="fd-type-meta text-fg-muted">
              {[
                sizeLabel,
                mediaKind
                  ? `${MAX_MEDIA_PREVIEW_BYTES / 1_000_000} MB limit`
                  : '1 MB limit',
              ]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
        ) : file?.is_binary ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
            <p className="text-[length:var(--fd-text-xs)] text-fg-secondary">This file isn't previewable</p>
            <p className="fd-type-meta text-fg-muted">
              {[fileName, sizeLabel].filter(Boolean).join(' · ')}
            </p>
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
        ) : showPreview && canPreviewMarkdown && file?.content != null ? (
          <MarkdownFileDocument text={file.content} />
        ) : file?.content != null ? (
          <div className="font-mono text-[length:var(--fd-text-2xs)] leading-5">
            {lines.map((text, index) => (
              <HighlightedFileLine
                key={index}
                lineNumber={index + 1}
                text={text}
                tokens={tokens?.[index] ?? null}
                active={index + 1 === targetLine}
              />
            ))}
          </div>
        ) : null}
      </div>
      {!showMedia && !waitingForMedia && !isLoading && textStatus ? (
        <div className="flex h-8 shrink-0 items-center border-t border-border-subtle px-3">
          <p className="fd-type-meta min-w-0 truncate tabular-nums text-fg-muted">{textStatus}</p>
        </div>
      ) : null}
    </div>
  )
})

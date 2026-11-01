import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ArrowUpRight, FolderOpen, X } from 'lucide-react'

import {
  HighlightedFileLine,
  languageFromPath,
  revealInFolderLabel,
  useShikiTokens,
} from '@falcondeck/chat-ui'
import {
  formatArtifactSize,
  type DaemonApiClient,
  type FilePreviewMeta,
} from '@falcondeck/client-core'
import { ActivityDiamond, Button } from '@falcondeck/ui'

import { openLocalPath, revealLocalPath } from '../api'
import {
  absolutePathForActions,
  fileRequestFor,
  htmlPreviewDocument,
  parseFileFailure,
  previewSurfaceFor,
  previewTargetKey,
  type FileFailure,
  type FilePreviewTarget,
  type PreviewSurface,
} from '../local-file-links'
import { basePart, dirPart } from './diff/diff-utils'
import { FileTypeIcon } from './diff/FileTypeIcon'
import { FilePreviewToggle, MarkdownFileDocument } from './diff/markdown-file'
import { MediaFilePreview } from './diff/media-file'
import { MAX_MARKDOWN_PREVIEW_CHARS, type FilePreviewMode } from './diff/markdown-preview'

type PreviewApi = Pick<DaemonApiClient, 'statFile' | 'readFile'>

type PreviewState =
  | { status: 'loading' }
  | { status: 'failed'; failure: FileFailure }
  | { status: 'blocked'; meta: FilePreviewMeta; surface: 'too_large' | 'unsupported' }
  | {
      status: 'ready'
      meta: FilePreviewMeta
      surface: Exclude<PreviewSurface, 'too_large' | 'unsupported'>
      text: string | null
      bytes: Uint8Array | null
      objectUrl: string | null
    }

function usePreview(target: FilePreviewTarget | null, api: PreviewApi | null, reloadKey: number) {
  const [state, setState] = useState<PreviewState>({ status: 'loading' })
  const key = target ? previewTargetKey(target) : null

  useEffect(() => {
    if (!target) return
    if (!api) {
      setState({
        status: 'failed',
        failure: { code: null, reason: 'FalconDeck isn’t connected to its background service right now.' },
      })
      return
    }
    let cancelled = false
    let objectUrl: string | null = null
    setState({ status: 'loading' })
    void (async () => {
      try {
        const request = fileRequestFor(target)
        const meta = await api.statFile(request)
        const surface = previewSurfaceFor(meta)
        if (cancelled) return
        if (surface === 'too_large' || surface === 'unsupported') {
          setState({ status: 'blocked', meta, surface })
          return
        }
        // Read the canonical file, so a relative link cannot resolve differently
        // the second time.
        const { blob } = await api.readFile({ ...request, path: meta.path })
        if (cancelled) return
        if (surface === 'image' || surface === 'video' || surface === 'audio') {
          objectUrl = URL.createObjectURL(blob)
          setState({ status: 'ready', meta, surface, text: null, bytes: null, objectUrl })
        } else if (surface === 'pdf') {
          const bytes = new Uint8Array(await blob.arrayBuffer())
          if (!cancelled) setState({ status: 'ready', meta, surface, text: null, bytes, objectUrl: null })
        } else {
          const text = await blob.text()
          if (!cancelled) setState({ status: 'ready', meta, surface, text, bytes: null, objectUrl: null })
        }
      } catch (error) {
        if (!cancelled) setState({ status: 'failed', failure: parseFileFailure(error) })
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
    // `key` stands for the target's identity; a fresh object with the same
    // fields must not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, api, reloadKey])

  return state
}

function Fallback({
  title,
  detail,
  code,
  children,
}: {
  title: string
  detail?: string | null
  code?: string | null
  children?: React.ReactNode
}) {
  return (
    <div
      role="status"
      className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center"
    >
      <p className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">{title}</p>
      {detail ? (
        <p className="max-w-[46ch] text-[length:var(--fd-text-sm)] text-fg-secondary">{detail}</p>
      ) : null}
      {code ? <p className="fd-type-meta font-mono text-fg-muted">{code}</p> : null}
      {children ? <div className="mt-2 flex flex-wrap items-center justify-center gap-2">{children}</div> : null}
    </div>
  )
}

function TextLines({ text, path }: { text: string; path: string }) {
  const lines = useMemo(() => text.replace(/\r\n/g, '\n').split('\n'), [text])
  const language = useMemo(() => languageFromPath(path), [path])
  // Highlighting thousands of lines on open makes the dialog stall.
  const tokens = useShikiTokens(lines.length <= 2_000 ? lines : [], language)
  return (
    <div className="font-mono text-[length:var(--fd-text-2xs)] leading-5">
      {lines.map((line, index) => (
        <HighlightedFileLine
          key={index}
          lineNumber={index + 1}
          text={line}
          tokens={tokens?.[index] ?? null}
          active={false}
        />
      ))}
    </div>
  )
}

export type FilePreviewDialogProps = {
  target: FilePreviewTarget | null
  /** Null while the daemon is unreachable; the dialog then offers only the OS actions. */
  api: PreviewApi | null
  onClose: () => void
  /** Overridable for tests; default to the desktop commands. */
  onReveal?: (path: string) => Promise<void>
  onOpenDefault?: (path: string) => Promise<void>
}

export function FilePreviewDialog({
  target,
  api,
  onClose,
  onReveal = revealLocalPath,
  onOpenDefault = openLocalPath,
}: FilePreviewDialogProps) {
  const [reloadKey, setReloadKey] = useState(0)
  const [mode, setMode] = useState<FilePreviewMode>('preview')
  const [actionError, setActionError] = useState<string | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const returnFocusRef = useRef<Element | null>(null)
  const state = usePreview(target, api, reloadKey)
  const key = target ? previewTargetKey(target) : null

  useEffect(() => {
    setMode('preview')
    setActionError(null)
  }, [key])

  // Focus moves into the dialog and comes back to the link that opened it.
  useEffect(() => {
    if (!target) return
    returnFocusRef.current = document.activeElement
    dialogRef.current?.focus()
    return () => {
      const previous = returnFocusRef.current
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
    // Only when the dialog opens or closes, not when the file changes under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target === null])

  const meta =
    state.status === 'ready' || state.status === 'blocked' ? state.meta : null
  const actionPath = target ? absolutePathForActions(target, meta) : null
  const revealLabel = revealInFolderLabel()

  const run = useCallback(
    (action: (path: string) => Promise<void>, path: string) => {
      setActionError(null)
      void action(path).catch((error: unknown) =>
        setActionError(error instanceof Error ? error.message : String(error)),
      )
    },
    [],
  )

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
      return
    }
    if (event.key !== 'Tab') return
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input, select, textarea, iframe, [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    const active = document.activeElement
    if (event.shiftKey && (active === first || active === dialogRef.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }

  if (!target) return null

  const name = meta?.name ?? basePart(target.path.replace(/^file:\/\//i, '')) ?? target.path
  const directory = meta ? dirPart(meta.path) : null
  const headingId = 'file-preview-title'
  const tooBigToRender =
    state.status === 'ready' &&
    state.surface === 'markdown' &&
    (state.text?.length ?? 0) > MAX_MARKDOWN_PREVIEW_CHARS
  const canToggleSource =
    state.status === 'ready' &&
    !tooBigToRender &&
    (state.surface === 'markdown' || state.surface === 'html')
  const showSource = tooBigToRender || (canToggleSource && mode === 'source')

  const actions = actionPath ? (
    <>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => run(onReveal, actionPath)}
      >
        <FolderOpen aria-hidden="true" className="h-3.5 w-3.5" />
        {revealLabel}
      </Button>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => run(onOpenDefault, actionPath)}
      >
        <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
        Open in default app
      </Button>
    </>
  ) : null

  let body: React.ReactNode
  if (state.status === 'loading') {
    body = (
      <div className="flex h-full items-center justify-center" role="status" aria-label="Loading file">
        <ActivityDiamond size="lg" />
      </div>
    )
  } else if (state.status === 'failed') {
    const denied = state.failure.code === 'file_denied'
    body = (
      <Fallback
        title={denied ? 'FalconDeck can’t show this file' : 'This file couldn’t be loaded'}
        detail={state.failure.reason}
        code={state.failure.code}
      >
        {actions}
        {!actionPath ? (
          <p className="fd-type-meta text-fg-muted">
            There is no absolute path to hand to {revealLabel === 'Reveal in Finder' ? 'Finder' : 'the file manager'}.
          </p>
        ) : null}
      </Fallback>
    )
  } else if (state.status === 'blocked') {
    const size = formatArtifactSize(state.meta.size_bytes)
    body = (
      <Fallback
        title={state.surface === 'too_large' ? 'This file is too large to preview' : 'This file can’t be previewed'}
        detail={[state.meta.name, size].filter(Boolean).join(' · ')}
      >
        {actions}
      </Fallback>
    )
  } else if (state.surface === 'markdown' && state.text != null && !showSource) {
    body = (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-3xl py-2">
          <MarkdownFileDocument text={state.text} />
        </div>
      </div>
    )
  } else if (state.surface === 'html' && state.text != null && !showSource) {
    body = (
      // No allow-scripts and no allow-same-origin: the page cannot run code,
      // reach the app, or read storage. The injected policy also blocks the
      // network (see htmlPreviewDocument).
      <iframe
        title={`Preview of ${name}`}
        sandbox=""
        referrerPolicy="no-referrer"
        srcDoc={htmlPreviewDocument(state.text)}
        className="h-full w-full border-0 bg-white"
      />
    )
  } else if (state.text != null) {
    body = (
      <div className="h-full overflow-auto">
        <TextLines text={state.text} path={state.meta.path} />
      </div>
    )
  } else if (state.surface === 'pdf' || state.objectUrl) {
    body = (
      <MediaFilePreview
        kind={state.surface as 'image' | 'video' | 'audio' | 'pdf'}
        src={state.objectUrl ?? ''}
        fileName={state.meta.name}
        sizeBytes={state.meta.size_bytes}
        contentBytes={state.bytes}
      />
    )
  } else {
    body = <Fallback title="This file can’t be previewed" />
  }

  const facts =
    meta != null
      ? [formatArtifactSize(meta.size_bytes), meta.kind !== 'binary' ? meta.kind : null]
          .filter((fact): fact is string => Boolean(fact))
          .join(' · ')
      : null

  return (
    <div
      role="presentation"
      className="pointer-events-auto fixed inset-0 z-50 flex items-center justify-center bg-[var(--fd-overlay)] p-4 backdrop-blur-sm sm:p-8"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        className="relative flex h-[min(46rem,88vh)] w-full max-w-5xl flex-col overflow-hidden rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 shadow-[var(--fd-shadow-lg)] outline-none"
      >
        <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border-subtle px-4 py-2">
          <FileTypeIcon path={meta?.path ?? target.path} />
          <div className="min-w-0 flex-1">
            <h2
              id={headingId}
              className="truncate text-[length:var(--fd-text-sm)] font-semibold text-fg-primary"
            >
              {target.title ?? name}
            </h2>
            <p
              title={meta?.path ?? target.path}
              className="fd-type-meta truncate text-fg-muted"
            >
              {[target.title ? name : null, directory ?? (meta ? null : target.path), facts]
                .filter(Boolean)
                .join(' · ')}
            </p>
          </div>
          {canToggleSource ? <FilePreviewToggle mode={mode} onChange={setMode} /> : null}
          {state.status === 'ready' ? actions : null}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close preview"
            onClick={onClose}
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        </header>
        {actionError ? (
          <div
            role="alert"
            className="border-b border-danger/30 bg-danger-muted px-4 py-2 text-[length:var(--fd-text-xs)] text-danger"
          >
            {actionError}
          </div>
        ) : null}
        <div className="min-h-0 flex-1">{body}</div>
        {state.status === 'failed' && api && (state.failure.code === null || state.failure.code === 'file_changed') ? (
          <footer className="flex shrink-0 justify-end border-t border-border-subtle px-4 py-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setReloadKey((current) => current + 1)}
            >
              Try again
            </Button>
          </footer>
        ) : null}
      </div>
    </div>
  )
}

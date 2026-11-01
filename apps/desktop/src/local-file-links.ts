import {
  decodeFileUrl,
  parseLocalFilePath,
  type FilePreviewMeta,
  type LocalFileRequest,
} from '@falcondeck/client-core'

/** A file on this computer, named the way the agent wrote it. */
export type FilePreviewTarget = {
  /** Absolute, `~/`, `file://` or relative; the daemon resolves it. */
  path: string
  /** Directory of the document the link was written in, for relative links. */
  baseDir?: string
  workspaceId?: string
  threadId?: string
  /** Shown above the file name when the caller knows more, e.g. an evidence title. */
  title?: string
}

/**
 * The local file a link's `href` names, or null for anything else. Only the
 * explicit forms count: `file://` URLs, `~/…`, and absolute paths under a known
 * Unix root. A relative `src/app.ts` is deliberately not claimed here, because
 * in an arbitrary anchor it could just as well be an app route.
 */
export function localFileFromHref(href: string | null | undefined): string | null {
  if (!href) return null
  const trimmed = href.trim()
  if (!trimmed || trimmed.startsWith('#')) return null

  if (/^file:/i.test(trimmed)) {
    // Query and fragment are link syntax, not part of the name.
    const withoutSuffix = trimmed.replace(/[?#].*$/, '')
    const decoded = decodeFileUrl(withoutSuffix)
    return decoded ? parseLocalFilePath(decoded) : null
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed) && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    return null
  }

  let path = trimmed
  try {
    path = decodeURIComponent(trimmed)
  } catch {
    // An unescaped `%` in a real filename: use the text as written.
  }
  return parseLocalFilePath(path.replace(/#[^/]*$/, ''))
}

/** `file.stat` / `file.read` arguments for a target. */
export function fileRequestFor(target: FilePreviewTarget): LocalFileRequest {
  return {
    path: target.path,
    ...(target.baseDir ? { base_dir: target.baseDir } : {}),
    ...(target.workspaceId ? { workspace_id: target.workspaceId } : {}),
    ...(target.threadId ? { thread_id: target.threadId } : {}),
  }
}

/** A stable identity for a target, so a reopened preview refetches only when it changed. */
export function previewTargetKey(target: FilePreviewTarget): string {
  return [target.path, target.baseDir ?? '', target.workspaceId ?? '', target.threadId ?? ''].join('\u001f')
}

export type FileFailure = {
  /** `file_denied`, `file_not_found`, … or null for a network or unknown error. */
  code: string | null
  /** The text after the code, safe to show. */
  reason: string
}

/** Splits a daemon error such as `file_denied: This file isn't shareable.` */
export function parseFileFailure(error: unknown): FileFailure {
  const message = error instanceof Error ? error.message : String(error ?? '')
  const match = /^(file_[a-z_]+)\s*:\s*([\s\S]*)$/.exec(message.trim())
  if (match) return { code: match[1], reason: match[2].trim() || message.trim() }
  return { code: null, reason: message.trim() || 'The file could not be read.' }
}

/** Text-like previews are read in full into the page; keep that bounded. */
export const MAX_TEXT_PREVIEW_BYTES = 2_000_000
/** Mirrors the daemon's whole-file ceiling for images, PDFs and media. */
export const MAX_BINARY_PREVIEW_BYTES = 25_000_000

export type PreviewSurface =
  | 'markdown'
  | 'html'
  | 'image'
  | 'pdf'
  | 'video'
  | 'audio'
  | 'code'
  | 'text'
  | 'too_large'
  | 'unsupported'

/** Which viewer a file gets, from the metadata the daemon returned. */
export function previewSurfaceFor(
  meta: Pick<FilePreviewMeta, 'kind' | 'size_bytes'>,
): PreviewSurface {
  switch (meta.kind) {
    case 'markdown':
    case 'html':
    case 'code':
    case 'text':
      return meta.size_bytes > MAX_TEXT_PREVIEW_BYTES ? 'too_large' : meta.kind
    case 'image':
    case 'pdf':
    case 'video':
    case 'audio':
      return meta.size_bytes > MAX_BINARY_PREVIEW_BYTES ? 'too_large' : meta.kind
    default:
      return 'unsupported'
  }
}

/**
 * Wraps a document for the sandboxed preview frame. The frame carries no
 * `allow-scripts` and no `allow-same-origin`, so scripts never run and the page
 * is an opaque origin. This policy closes the remaining hole: nothing may load
 * from the network, so a report cannot beacon home or pull remote assets.
 */
export const HTML_PREVIEW_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'"

export function htmlPreviewDocument(source: string): string {
  // The policy has to be the first thing the parser sees: anything ahead of it
  // (an <img> before <head>, say) would load under the looser inherited policy.
  // A doctype of the document's own is harmlessly ignored when it comes second.
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">${source}`
}

/** The path the OS opener should be given, when one can be worked out. */
export function absolutePathForActions(
  target: FilePreviewTarget,
  meta: Pick<FilePreviewMeta, 'path'> | null,
): string | null {
  if (meta?.path) return meta.path
  const path = target.path.trim()
  if (/^(?:file:|~\/|\/|[A-Za-z]:[\\/])/i.test(path)) return path
  if (target.baseDir) return `${target.baseDir.replace(/\/+$/, '')}/${path.replace(/^\.\//, '')}`
  return null
}

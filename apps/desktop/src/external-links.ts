import { useEffect } from 'react'
import { useToast } from '@falcondeck/ui'
import { openExternalUrl } from './api'

/** Schemes that should leave the app and open in the OS default handler. */
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:'])

/**
 * Resolve an anchor's href to an absolute URL when it is safe to open
 * externally. Returns null for same-document anchors, relative app routes,
 * javascript:, and anything we should not hand to the OS.
 */
export function resolveExternalHref(
  href: string | null | undefined,
  baseHref: string = typeof window !== 'undefined'
    ? window.location.href
    : 'http://localhost/',
): string | null {
  if (!href) return null
  const trimmed = href.trim()
  if (
    !trimmed ||
    trimmed.startsWith('#') ||
    trimmed.toLowerCase().startsWith('javascript:')
  ) {
    return null
  }

  try {
    const url = new URL(trimmed, baseHref)
    if (!EXTERNAL_SCHEMES.has(url.protocol)) return null

    // Relative same-origin paths stay inside the app shell. Absolute http(s)
    // destinations (and mailto/tel) always open externally — chat markdown,
    // pairing links, docs, etc.
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      const isAbsolute = /^https?:\/\//i.test(trimmed)
      if (!isAbsolute && url.origin === new URL(baseHref).origin) {
        return null
      }
    }

    return url.href
  } catch {
    return null
  }
}

function anchorFromEventTarget(
  target: EventTarget | null,
): HTMLAnchorElement | null {
  if (!(target instanceof Element)) return null
  return target.closest('a[href]')
}

function shouldHandleClick(event: MouseEvent): boolean {
  // Primary and middle-click only. Right-click keeps the context menu so
  // users can still copy the URL.
  if (event.button !== 0 && event.button !== 1) return false
  // Let the browser handle modified clicks that already express intent
  // (e.g. open in new background tab on some platforms) — we still intercept
  // because Tauri/WKWebView will not open a real browser tab either way.
  if (event.defaultPrevented) return false
  return true
}

/** Own link feedback outside the message markup. */
export function ExternalLinkHandler() {
  const { toast } = useToast()
  useEffect(() => installExternalLinkHandler(openExternalUrl, () => {
    toast({
      variant: 'danger',
      title: 'Couldn’t open link',
      description: 'Try again or copy the link into your browser.',
    })
  }), [toast])
  return null
}

/**
 * Install a capture-phase click interceptor so markdown and other `<a href>`
 * links open in the system browser instead of navigating the Tauri webview.
 *
 * Mirrors the Electron/VS Code pattern: intercept anchors, hand off via the
 * platform opener, never let the embedded webview leave the app shell.
 *
 * Returns an uninstall function (useful for tests).
 */
export function installExternalLinkHandler(
  openUrl: (url: string) => Promise<void> = openExternalUrl,
  onError: () => void = () => {},
): () => void {
  let installed = true
  const requestVersions = new WeakMap<HTMLAnchorElement, number>()

  const handle = (event: MouseEvent) => {
    if (!shouldHandleClick(event)) return

    const anchor = anchorFromEventTarget(event.target)
    if (!anchor) return

    // Explicit opt-out for rare in-app anchors that should navigate normally.
    if (anchor.dataset.external === 'false') return

    const external = resolveExternalHref(anchor.getAttribute('href'))
    if (!external) return

    event.preventDefault()
    event.stopPropagation()

    const requestVersion = (requestVersions.get(anchor) ?? 0) + 1
    requestVersions.set(anchor, requestVersion)
    const reportFailure = (error: unknown) => {
      if (!installed || requestVersions.get(anchor) !== requestVersion) return
      console.error('Failed to open external URL', external, error)
      onError()
    }
    // Preserve the browser's user activation for window.open.
    try {
      void openUrl(external).catch(reportFailure)
    } catch (error) {
      reportFailure(error)
    }
  }

  document.addEventListener('click', handle, true)
  document.addEventListener('auxclick', handle, true)

  return () => {
    document.removeEventListener('click', handle, true)
    document.removeEventListener('auxclick', handle, true)
    installed = false
  }
}

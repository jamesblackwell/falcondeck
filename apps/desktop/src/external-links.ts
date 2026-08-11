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

type ExternalOpenFailure = {
  status: HTMLSpanElement
  previousDescribedBy: string | null
  previousTitle: string | null
}

let externalOpenStatusId = 0

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
): () => void {
  const failures = new WeakMap<HTMLAnchorElement, ExternalOpenFailure>()
  const requestVersions = new WeakMap<HTMLAnchorElement, number>()
  const failedAnchors = new Set<HTMLAnchorElement>()

  const clearFailure = (anchor: HTMLAnchorElement) => {
    const failure = failures.get(anchor)
    if (!failure) return
    failure.status.remove()
    if (failure.previousDescribedBy) {
      anchor.setAttribute('aria-describedby', failure.previousDescribedBy)
    } else {
      anchor.removeAttribute('aria-describedby')
    }
    if (failure.previousTitle) {
      anchor.setAttribute('title', failure.previousTitle)
    } else {
      anchor.removeAttribute('title')
    }
    failures.delete(anchor)
    failedAnchors.delete(anchor)
  }

  const showStatus = (
    anchor: HTMLAnchorElement,
    message: string,
    state: 'failed' | 'retrying',
  ) => {
    if (!anchor.isConnected) return
    let failure = failures.get(anchor)
    if (!failure) {
      const status = document.createElement('span')
      externalOpenStatusId += 1
      status.id = `fd-external-open-status-${externalOpenStatusId}`
      status.setAttribute('role', 'status')
      status.setAttribute('aria-live', 'polite')
      status.setAttribute('aria-atomic', 'true')
      status.className =
        'ml-2 inline-flex rounded-[var(--fd-radius-sm)] bg-danger/10 px-1.5 py-0.5 text-[length:var(--fd-text-xs)] leading-tight text-danger'
      failure = {
        status,
        previousDescribedBy: anchor.getAttribute('aria-describedby'),
        previousTitle: anchor.getAttribute('title'),
      }
      failures.set(anchor, failure)
      failedAnchors.add(anchor)
    }
    if (!failure.status.isConnected) {
      anchor.insertAdjacentElement('afterend', failure.status)
    }
    failure.status.dataset.externalOpenStatus = state
    failure.status.textContent = message
    anchor.setAttribute(
      'aria-describedby',
      [failure.previousDescribedBy, failure.status.id]
        .filter(Boolean)
        .join(' '),
    )
    anchor.setAttribute('title', 'Retry opening external link')
  }

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
    if (failures.has(anchor)) {
      showStatus(anchor, 'Opening link again…', 'retrying')
    }

    void Promise.resolve()
      .then(() => openUrl(external))
      .then(() => {
        if (requestVersions.get(anchor) !== requestVersion) return
        clearFailure(anchor)
      })
      .catch((error) => {
        if (requestVersions.get(anchor) !== requestVersion) return
        console.error('Failed to open external URL', external, error)
        showStatus(anchor, 'Could not open link. Select it to retry.', 'failed')
      })
  }

  document.addEventListener('click', handle, true)
  document.addEventListener('auxclick', handle, true)

  return () => {
    document.removeEventListener('click', handle, true)
    document.removeEventListener('auxclick', handle, true)
    for (const anchor of failedAnchors) clearFailure(anchor)
  }
}

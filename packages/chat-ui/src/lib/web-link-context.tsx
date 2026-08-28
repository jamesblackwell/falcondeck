import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { Copy, ExternalLink } from 'lucide-react'

import { MenuRow, MenuSurface, type MenuPosition } from './menu-surface'

export type WebLinkOpener = (url: string) => void | Promise<void>

type WebLinkMenuState = {
  url: string
  x: number
  y: number
}

type WebLinkContextValue = {
  onOpenLink: WebLinkOpener
  openMenu: (url: string, position: MenuPosition) => void
}

const WebLinkContext = createContext<WebLinkContextValue | null>(null)

async function copyTextToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const textarea = document.createElement('textarea')
    textarea.value = text
    textarea.style.position = 'fixed'
    textarea.style.opacity = '0'
    document.body.appendChild(textarea)
    textarea.select()
    document.execCommand('copy')
    textarea.remove()
  }
}

export function WebLinkProvider({
  onOpenLink,
  children,
}: {
  onOpenLink?: WebLinkOpener | null
  children: ReactNode
}) {
  const [menu, setMenu] = useState<WebLinkMenuState | null>(null)
  const opener = onOpenLink ?? null

  const openMenu = useCallback((url: string, position: MenuPosition) => {
    setMenu({ url, x: position.x, y: position.y })
  }, [])

  const closeMenu = useCallback(() => setMenu(null), [])

  const value = useMemo(
    () => (opener ? { onOpenLink: opener, openMenu } : null),
    [opener, openMenu],
  )

  return (
    <WebLinkContext.Provider value={value}>
      {children}
      {menu && opener ? (
        <WebLinkMenu menu={menu} onOpenLink={opener} onClose={closeMenu} />
      ) : null}
    </WebLinkContext.Provider>
  )
}

export function useWebLinkMenu(): WebLinkContextValue | null {
  return useContext(WebLinkContext)
}

/**
 * Markdown anchor that gains a right-click menu (open, copy) when a host
 * provides one. Without a provider — remote web, exports — the anchor keeps
 * the plain `target="_blank"` behaviour.
 */
export function WebLinkAnchor({
  href,
  className,
  children,
}: {
  href: string
  className?: string
  children?: ReactNode
}) {
  const context = useWebLinkMenu()

  if (!context) {
    return (
      <a href={href} className={className} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    )
  }

  return (
    <a
      href={href}
      className={className}
      target="_blank"
      rel="noopener noreferrer"
      onContextMenu={(event) => {
        event.preventDefault()
        event.stopPropagation()
        context.openMenu(href, { x: event.clientX, y: event.clientY })
      }}
    >
      {children}
    </a>
  )
}

function WebLinkMenu({
  menu,
  onOpenLink,
  onClose,
}: {
  menu: WebLinkMenuState
  onOpenLink: WebLinkOpener
  onClose: () => void
}) {
  const iconClassName = 'h-3.5 w-3.5 text-fg-muted'

  return (
    <MenuSurface
      position={{ x: menu.x, y: menu.y }}
      itemCount={2}
      ariaLabel={`Actions for ${menu.url}`}
      onClose={onClose}
    >
      <MenuRow
        icon={<ExternalLink className={iconClassName} />}
        label="Open Link"
        onClick={() => {
          onClose()
          void onOpenLink(menu.url)
        }}
      />
      <MenuRow
        icon={<Copy className={iconClassName} />}
        label="Copy Link"
        onClick={() => {
          void copyTextToClipboard(menu.url).finally(onClose)
        }}
      />
    </MenuSurface>
  )
}

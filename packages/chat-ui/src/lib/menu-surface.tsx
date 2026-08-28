import {
  useEffect,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@falcondeck/ui'

export type MenuPosition = { x: number; y: number }

const MENU_WIDTH_PX = 224
const MENU_PADDING_PX = 4
const MENU_ROW_HEIGHT_PX = 36
const MENU_VIEWPORT_PADDING_PX = 8

export function MenuSurface({
  position,
  itemCount,
  ariaLabel,
  onClose,
  children,
}: {
  position: MenuPosition
  itemCount: number
  ariaLabel: string
  onClose: () => void
  children: ReactNode
}) {
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return
      onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [onClose])

  useEffect(() => {
    menuRef.current
      ?.querySelector<HTMLButtonElement>(':scope > [role="menuitem"]')
      ?.focus()
  }, [])

  if (typeof document === 'undefined') return null

  const menuHeight =
    MENU_VIEWPORT_PADDING_PX * 2 +
    MENU_PADDING_PX * 2 +
    MENU_ROW_HEIGHT_PX * itemCount
  const left = Math.max(
    MENU_VIEWPORT_PADDING_PX,
    Math.min(
      position.x,
      window.innerWidth - MENU_WIDTH_PX - MENU_VIEWPORT_PADDING_PX,
    ),
  )
  const top = Math.max(
    MENU_VIEWPORT_PADDING_PX,
    Math.min(
      position.y,
      window.innerHeight - menuHeight - MENU_VIEWPORT_PADDING_PX,
    ),
  )

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return
    }
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLButtonElement>(
        ':scope > [role="menuitem"]',
      ),
    )
    if (items.length === 0) return
    event.preventDefault()
    const currentIndex = items.indexOf(
      document.activeElement as HTMLButtonElement,
    )
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (currentIndex + 1 + items.length) % items.length
            : (currentIndex - 1 + items.length) % items.length
    items[nextIndex]?.focus()
  }

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
      className="fixed z-50 w-56 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-1 shadow-[var(--fd-shadow-lg)]"
      style={{ left, top }}
    >
      {children}
    </div>,
    document.body,
  )
}

export function MenuRow({
  icon,
  label,
  onClick,
  className,
  onPointerDown,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  className?: string
  onPointerDown?: (event: ReactMouseEvent<HTMLButtonElement>) => void
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      onPointerDown={onPointerDown}
      className={cn(
        'fd-focus-fill flex h-9 w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2.5 text-left text-[length:var(--fd-text-sm)] text-fg-primary hover:bg-surface-3 focus-visible:bg-surface-3',
        className,
      )}
    >
      <span aria-hidden="true" className="flex shrink-0 items-center">
        {icon}
      </span>
      {label}
    </button>
  )
}

import * as React from 'react'
import * as ToastPrimitive from '@radix-ui/react-toast'
import { X } from 'lucide-react'
import { cva, type VariantProps } from 'class-variance-authority'

import { cn } from '../lib/utils'

/* ---------------------------------------------------------------------------
 * Variants
 * -------------------------------------------------------------------------- */

const toastVariants = cva(
  [
    'pointer-events-auto relative flex items-start gap-3 overflow-hidden',
    'rounded-[var(--fd-radius-lg)] border p-3 pr-10',
    'shadow-[var(--fd-shadow-lg)]',
    'data-[state=open]:animate-toast-in data-[state=closed]:animate-toast-out',
    'data-[swipe=move]:translate-x-[var(--radix-toast-swipe-move-x)]',
    'data-[swipe=cancel]:translate-x-0 data-[swipe=cancel]:transition-transform',
    'data-[swipe=end]:animate-toast-out',
  ].join(' '),
  {
    variants: {
      variant: {
        default: 'border-border-default bg-surface-2 text-fg-primary',
        success: 'border-success/20 bg-success-muted text-success',
        warning: 'border-warning/20 bg-warning-muted text-warning',
        danger: 'border-danger/20 bg-danger-muted text-danger',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
)

/* ---------------------------------------------------------------------------
 * Toast primitives (styled)
 * -------------------------------------------------------------------------- */

type ToastVariant = VariantProps<typeof toastVariants>['variant']

interface ToastProps
  extends React.ComponentPropsWithoutRef<typeof ToastPrimitive.Root>,
    VariantProps<typeof toastVariants> {}

const Toast = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Root>,
  ToastProps
>(({ className, variant, ...props }, ref) => (
  <ToastPrimitive.Root
    ref={ref}
    className={cn(toastVariants({ variant, className }))}
    {...props}
  />
))
Toast.displayName = 'Toast'

const ToastClose = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Close>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Close>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Close
    ref={ref}
    className={cn(
      'absolute right-2 top-2 inline-flex items-center justify-center rounded-[var(--fd-radius-sm)] p-1 text-fg-muted transition-colors duration-[var(--fd-duration-fast)] hover:text-fg-primary focus:outline-none',
      className,
    )}
    toast-close=""
    {...props}
  >
    <X className="h-3.5 w-3.5" />
  </ToastPrimitive.Close>
))
ToastClose.displayName = 'ToastClose'

const ToastTitle = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Title>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Title
    ref={ref}
    className={cn('text-[length:var(--fd-text-sm)] font-medium leading-[var(--fd-leading-tight)]', className)}
    {...props}
  />
))
ToastTitle.displayName = 'ToastTitle'

const ToastDescription = React.forwardRef<
  React.ElementRef<typeof ToastPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof ToastPrimitive.Description>
>(({ className, ...props }, ref) => (
  <ToastPrimitive.Description
    ref={ref}
    className={cn('text-[length:var(--fd-text-xs)] text-fg-secondary leading-[var(--fd-leading-normal)]', className)}
    {...props}
  />
))
ToastDescription.displayName = 'ToastDescription'

/* ---------------------------------------------------------------------------
 * Toast context & hook
 * -------------------------------------------------------------------------- */

interface ToastEntry {
  id: string
  variant: ToastVariant
  title: string
  description?: string
  duration?: number
}

interface ToastContextValue {
  toast: (options: Omit<ToastEntry, 'id'>) => void
}

const ToastContext = React.createContext<ToastContextValue | null>(null)

let toastCounter = 0

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastEntry[]>([])

  const addToast = React.useCallback((options: Omit<ToastEntry, 'id'>) => {
    const id = `toast-${++toastCounter}`
    setToasts((prev) => [...prev, { id, ...options }])
  }, [])

  const removeToast = React.useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
  }, [])

  const contextValue = React.useMemo<ToastContextValue>(() => ({ toast: addToast }), [addToast])

  return (
    <ToastContext value={contextValue}>
      <ToastPrimitive.Provider swipeDirection="right">
        {children}
        {toasts.map((t) => (
          <Toast
            key={t.id}
            variant={t.variant}
            duration={t.duration ?? 5000}
            onOpenChange={(open) => {
              if (!open) removeToast(t.id)
            }}
          >
            <div className="flex flex-col gap-1">
              <ToastTitle>{t.title}</ToastTitle>
              {t.description ? <ToastDescription>{t.description}</ToastDescription> : null}
            </div>
            <ToastClose />
          </Toast>
        ))}
        <ToastPrimitive.Viewport
          className={cn(
            'fixed bottom-0 right-0 z-[100] flex max-h-screen w-full max-w-sm flex-col gap-2 p-4',
          )}
        />
      </ToastPrimitive.Provider>
    </ToastContext>
  )
}

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext)
  if (!ctx) {
    throw new Error('useToast must be used within a <ToastProvider>')
  }
  return ctx
}

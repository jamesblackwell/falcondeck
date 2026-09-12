import { memo, useEffect, useState } from 'react'
import { FolderClosed, FolderOpen } from 'lucide-react'

import { workspaceColorCssVar } from '@falcondeck/client-core'
import { cn } from '@falcondeck/ui'

export const WorkspaceIcon = memo(function WorkspaceIcon({
  src,
  open = false,
  color,
  className,
}: {
  src?: string | null
  open?: boolean
  color?: string | null
  className?: string
}) {
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setFailed(false)
  }, [src])

  const folderColor = workspaceColorCssVar(color)
  if (!src || failed) {
    // Both glyphs stay mounted and crossfade: swapping the element outright
    // made the folder pop a frame before the rows started moving, which read
    // as two separate events instead of one disclosure.
    return (
      <span
        aria-hidden="true"
        className={cn(
          'relative inline-block h-4 w-4 shrink-0',
          folderColor ? null : 'text-fg-muted',
          className,
        )}
        style={folderColor ? { color: folderColor } : undefined}
      >
        <FolderClosed
          className={cn(
            'absolute inset-0 h-full w-full transition-opacity duration-[var(--fd-duration-fast)]',
            open ? 'opacity-0' : 'opacity-100',
          )}
        />
        <FolderOpen
          className={cn(
            'absolute inset-0 h-full w-full transition-opacity duration-[var(--fd-duration-fast)]',
            open ? 'opacity-100' : 'opacity-0',
          )}
        />
      </span>
    )
  }

  return (
    <img
      src={src}
      alt=""
      aria-hidden="true"
      className={cn('h-4 w-4 rounded-[3px] object-contain', className)}
      onError={() => setFailed(true)}
    />
  )
})

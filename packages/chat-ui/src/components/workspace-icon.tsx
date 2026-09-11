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
  const FolderGlyph = open ? FolderOpen : FolderClosed
  if (!src || failed) {
    return (
      <FolderGlyph
        aria-hidden="true"
        className={cn('h-4 w-4', folderColor ? null : 'text-fg-muted', className)}
        style={folderColor ? { color: folderColor } : undefined}
      />
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

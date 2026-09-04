import { memo } from 'react'
import {
  Braces,
  Database,
  FileCode2,
  FileJson,
  FileText,
  Film,
  Hash,
  Image,
  Music,
  Settings,
} from 'lucide-react'

import { extensionOf, mediaKindFromPath } from './media-file'

export const FileTypeIcon = memo(function FileTypeIcon({ path }: { path: string }) {
  const extension = extensionOf(path)
  const mediaKind = mediaKindFromPath(path)
  const className = 'h-3.5 w-3.5 shrink-0'

  if (mediaKind === 'image') {
    return <Image aria-hidden="true" className={`${className} text-accent`} />
  }
  if (mediaKind === 'video') {
    return <Film aria-hidden="true" className={`${className} text-accent`} />
  }
  if (mediaKind === 'audio') {
    return <Music aria-hidden="true" className={`${className} text-accent`} />
  }
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(extension)) {
    return <Braces aria-hidden="true" className={`${className} text-info`} />
  }
  if (['html', 'htm', 'xml'].includes(extension)) {
    return <FileCode2 aria-hidden="true" className={`${className} text-danger`} />
  }
  if (['css', 'scss', 'sass', 'less'].includes(extension)) {
    return <Hash aria-hidden="true" className={`${className} text-info`} />
  }
  if (['json', 'jsonc'].includes(extension)) {
    return <FileJson aria-hidden="true" className={`${className} text-warning`} />
  }
  if (['rs', 'toml', 'lock'].includes(extension)) {
    return <Settings aria-hidden="true" className={`${className} text-warning`} />
  }
  if (['sql', 'sqlite', 'db'].includes(extension)) {
    return <Database aria-hidden="true" className={`${className} text-accent`} />
  }
  if (['md', 'mdx', 'txt', 'rst'].includes(extension)) {
    return <FileText aria-hidden="true" className={`${className} text-fg-secondary`} />
  }
  return <FileCode2 aria-hidden="true" className={`${className} text-fg-muted`} />
})

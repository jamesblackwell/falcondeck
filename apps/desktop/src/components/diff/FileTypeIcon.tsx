import { memo } from 'react'
import {
  Braces,
  Database,
  FileCode2,
  FileJson,
  FileText,
  Hash,
  Image,
  Settings,
} from 'lucide-react'

const extensionPattern = /(?:^|\.)([^./]+)$/

function extensionFor(path: string) {
  return path.match(extensionPattern)?.[1]?.toLowerCase() ?? ''
}

export const FileTypeIcon = memo(function FileTypeIcon({ path }: { path: string }) {
  const extension = extensionFor(path)
  const className = 'h-3.5 w-3.5 shrink-0'

  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(extension)) {
    return <Braces aria-hidden="true" className={`${className} text-info`} />
  }
  if (['html', 'htm', 'xml', 'svg'].includes(extension)) {
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
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'avif'].includes(extension)) {
    return <Image aria-hidden="true" className={`${className} text-accent`} />
  }
  if (['md', 'mdx', 'txt', 'rst'].includes(extension)) {
    return <FileText aria-hidden="true" className={`${className} text-fg-secondary`} />
  }
  return <FileCode2 aria-hidden="true" className={`${className} text-fg-muted`} />
})

import { ArrowUpRight, Copy, Eye, FolderOpen, GitCompare, SquareCode } from 'lucide-react'

import {
  copyTextToClipboard,
  MenuRow,
  MenuSurface,
  revealInFolderLabel,
  type LocalPathEditor,
  type LocalPathHandler,
  type MenuPosition,
} from '@falcondeck/chat-ui'
import type { GitStatusEntry } from '@falcondeck/client-core'

export type FileBrowserMenuTarget = {
  path: string
  kind: 'file' | 'directory'
  source: 'changes' | 'files'
  entry: GitStatusEntry | null
  position: MenuPosition
}

export function FileBrowserContextMenu({
  target,
  localRoot,
  editors,
  onLocalPath,
  onSelectChangedFile,
  onSelectWorkspaceFile,
  onClose,
}: {
  target: FileBrowserMenuTarget
  localRoot: string | null
  editors: readonly LocalPathEditor[]
  onLocalPath: LocalPathHandler | null
  onSelectChangedFile: (entry: GitStatusEntry) => void
  onSelectWorkspaceFile: (path: string) => void
  onClose: () => void
}) {
  const localPath = localRoot ? `${localRoot.replace(/\/+$/, '')}/${target.path}` : null
  const entry = target.entry
  const exists = target.source === 'files' || entry?.status !== 'deleted'
  const canOpenLocally = Boolean(localPath && onLocalPath && exists)
  const isFile = target.kind === 'file'
  const revealLabel = revealInFolderLabel()
  const canOpenDefaultEditor = canOpenLocally && isFile && revealLabel === 'Reveal in Finder'
  const openFolderLabel =
    revealLabel === 'Reveal in Finder'
      ? 'Open in Finder'
      : revealLabel === 'Show in Explorer'
        ? 'Open in Explorer'
        : 'Open Folder'
  const iconClassName = 'h-3.5 w-3.5 text-fg-muted'
  const itemCount =
    Number(Boolean(entry && target.source === 'changes')) +
    Number(isFile && exists) +
    Number(Boolean(entry && target.source === 'files')) +
    (canOpenLocally ? 1 + editors.length + Number(isFile) : 0) +
    Number(canOpenDefaultEditor) +
    1 +
    Number(Boolean(localPath))

  const runLocalAction = (
    action: 'open' | 'open-default-editor' | 'reveal' | 'open-with',
    editorId?: string,
  ) => {
    onClose()
    if (localPath && onLocalPath) void onLocalPath(action, localPath, editorId)
  }
  const copyPath = (path: string) => {
    onClose()
    void copyTextToClipboard(path)
  }

  return (
    <MenuSurface
      position={target.position}
      itemCount={itemCount}
      ariaLabel={`Actions for ${target.path}`}
      onClose={onClose}
    >
      {target.source === 'changes' && entry ? (
        <MenuRow
          icon={<GitCompare className={iconClassName} />}
          label="View Changes"
          onClick={() => {
            onClose()
            onSelectChangedFile(entry)
          }}
        />
      ) : null}
      {isFile && exists ? (
        <MenuRow
          icon={<Eye className={iconClassName} />}
          label="Preview File"
          onClick={() => {
            onClose()
            onSelectWorkspaceFile(target.path)
          }}
        />
      ) : null}
      {target.source === 'files' && entry ? (
        <MenuRow
          icon={<GitCompare className={iconClassName} />}
          label="View Changes"
          onClick={() => {
            onClose()
            onSelectChangedFile(entry)
          }}
        />
      ) : null}
      {canOpenLocally ? (
        <>
          <MenuRow
            icon={isFile
              ? <ArrowUpRight className={iconClassName} />
              : <FolderOpen className={iconClassName} />}
            label={isFile ? 'Open in Default App' : openFolderLabel}
            onClick={() => runLocalAction('open')}
          />
          {canOpenDefaultEditor ? (
            <MenuRow
              icon={<SquareCode className={iconClassName} />}
              label="Open in Default Editor"
              onClick={() => runLocalAction('open-default-editor')}
            />
          ) : null}
          {editors.map((editor) => (
            <MenuRow
              key={editor.id}
              icon={<SquareCode className={iconClassName} />}
              label={`Open in ${editor.name}`}
              onClick={() => runLocalAction('open-with', editor.id)}
            />
          ))}
          {isFile ? (
            <MenuRow
              icon={<FolderOpen className={iconClassName} />}
              label={revealLabel}
              onClick={() => runLocalAction('reveal')}
            />
          ) : null}
        </>
      ) : null}
      <MenuRow
        icon={<Copy className={iconClassName} />}
        label="Copy Relative Path"
        onClick={() => copyPath(target.path)}
      />
      {localPath ? (
        <MenuRow
          icon={<Copy className={iconClassName} />}
          label="Copy Full Path"
          onClick={() => copyPath(localPath)}
        />
      ) : null}
    </MenuSurface>
  )
}

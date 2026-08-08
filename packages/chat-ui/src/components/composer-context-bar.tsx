import { memo, useEffect, useState, type FormEvent } from 'react'
import * as Popover from '@radix-ui/react-popover'
import { Check, FolderClosed, GitBranch, Laptop, LoaderCircle, Plus, Split } from 'lucide-react'

import type { GitBranchesResponse, ThreadIsolation, WorkspaceSummary } from '@falcondeck/client-core'
import { Select, SelectContent, SelectItem, SelectTrigger, cn } from '@falcondeck/ui'

export type ComposerContextBarProps = {
  workspaces: WorkspaceSummary[]
  selectedWorkspace: WorkspaceSummary | null
  onSelectWorkspace: (workspaceId: string) => void
  selectedIsolation: ThreadIsolation
  onIsolationChange: (value: ThreadIsolation) => void
  /** Branch state of the project folder; null hides the chip (remote host, not a repo). */
  branches?: GitBranchesResponse | null
  /** Changed-file count of the current checkout, shown under the active branch. */
  uncommittedCount?: number | null
  onCheckoutBranch?: (branch: string, create: boolean) => void | Promise<void>
  isCheckoutPending?: boolean
  disabled?: boolean
}

const CHIP_CLASS =
  'fd-focus inline-flex h-7 max-w-56 items-center gap-1.5 rounded-[var(--fd-radius-md)] px-2 text-[length:var(--fd-text-xs)] text-fg-secondary transition-colors duration-[var(--fd-duration-fast)] hover:bg-surface-3 hover:text-fg-primary disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-surface-3 data-[state=open]:text-fg-primary'

/**
 * The tab of thread-creation choices docked above the composer: which project,
 * where the thread runs, and which branch the project folder sits on. Only
 * meaningful before a thread exists — all three are fixed at creation, so the
 * host unmounts the bar once a thread is selected.
 */
export const ComposerContextBar = memo(function ComposerContextBar({
  workspaces,
  selectedWorkspace,
  onSelectWorkspace,
  selectedIsolation,
  onIsolationChange,
  branches = null,
  uncommittedCount = null,
  onCheckoutBranch,
  isCheckoutPending = false,
  disabled = false,
}: ComposerContextBarProps) {
  const projectLabel = selectedWorkspace
    ? selectedWorkspace.path.split('/').pop() || selectedWorkspace.path
    : 'Select a project'

  return (
    <div className="relative z-0 mx-3 -mb-3 flex items-center gap-0.5 rounded-t-[var(--fd-radius-xl)] border border-b-0 border-border-subtle bg-surface-3/60 px-2 pb-4 pt-1.5">
      <Select
        value={selectedWorkspace?.id ?? ''}
        onValueChange={onSelectWorkspace}
        disabled={disabled || workspaces.length === 0}
      >
        <SelectTrigger variant="quiet" aria-label="Project" className={CHIP_CLASS}>
          <FolderClosed aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
          <span className="truncate">{projectLabel}</span>
        </SelectTrigger>
        <SelectContent align="start">
          {workspaces.map((workspace) => (
            <SelectItem key={workspace.id} value={workspace.id}>
              {workspace.path.split('/').pop() || workspace.path}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={selectedIsolation}
        onValueChange={(next) => onIsolationChange(next as ThreadIsolation)}
        disabled={disabled}
      >
        <SelectTrigger variant="quiet" aria-label="Work in" className={CHIP_CLASS}>
          {selectedIsolation === 'isolated' ? (
            <Split aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
          ) : (
            <Laptop aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
          )}
          <span className="truncate">
            {selectedIsolation === 'isolated' ? 'Isolated copy' : 'Project folder'}
          </span>
        </SelectTrigger>
        <SelectContent align="start">
          <SelectItem value="project_folder">Project folder</SelectItem>
          <SelectItem value="isolated">Isolated copy</SelectItem>
        </SelectContent>
      </Select>

      {branches && onCheckoutBranch ? (
        <BranchMenu
          branches={branches}
          uncommittedCount={uncommittedCount}
          onCheckoutBranch={onCheckoutBranch}
          isCheckoutPending={isCheckoutPending}
          disabled={disabled}
        />
      ) : null}
    </div>
  )
})

function BranchMenu({
  branches,
  uncommittedCount,
  onCheckoutBranch,
  isCheckoutPending,
  disabled,
}: {
  branches: GitBranchesResponse
  uncommittedCount: number | null
  onCheckoutBranch: (branch: string, create: boolean) => void | Promise<void>
  isCheckoutPending: boolean
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [creating, setCreating] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')

  // A fresh open always starts on the list, not a stale half-typed name.
  useEffect(() => {
    if (!open) {
      setCreating(false)
      setNewBranchName('')
    }
  }, [open])

  const handleCreate = (event: FormEvent) => {
    event.preventDefault()
    const name = newBranchName.trim()
    if (!name) return
    void onCheckoutBranch(name, true)
    setOpen(false)
  }

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" aria-label="Git branch" disabled={disabled} className={CHIP_CLASS}>
          {isCheckoutPending ? (
            <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 shrink-0 animate-spin text-fg-muted" />
          ) : (
            <GitBranch aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
          )}
          <span className="truncate">{branches.current ?? 'detached'}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 w-72 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-1 shadow-[var(--fd-shadow-lg)]"
        >
          <p className="px-2.5 pb-1 pt-1.5 text-[length:var(--fd-text-2xs)] font-medium uppercase tracking-[0.08em] text-fg-muted">
            Branches
          </p>
          <div className="max-h-64 overflow-y-auto">
            {branches.branches.map((branch) => {
              const isCurrent = branch === branches.current
              return (
                <button
                  key={branch}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isCurrent}
                  disabled={isCheckoutPending}
                  onClick={() => {
                    if (!isCurrent) {
                      void onCheckoutBranch(branch, false)
                    }
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-left text-[length:var(--fd-text-sm)] text-fg-primary transition-colors hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60',
                  )}
                >
                  <GitBranch aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{branch}</span>
                    {isCurrent && uncommittedCount ? (
                      <span className="block text-[length:var(--fd-text-xs)] text-fg-muted">
                        Uncommitted: {uncommittedCount} {uncommittedCount === 1 ? 'file' : 'files'}
                      </span>
                    ) : null}
                  </span>
                  {isCurrent ? <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" /> : null}
                </button>
              )
            })}
          </div>
          <div className="mt-1 border-t border-border-subtle pt-1">
            {creating ? (
              <form onSubmit={handleCreate} className="flex items-center gap-1 px-1 py-1">
                <input
                  autoFocus
                  value={newBranchName}
                  onChange={(event) => setNewBranchName(event.target.value)}
                  placeholder="new-branch-name"
                  aria-label="New branch name"
                  className="fd-focus h-7 min-w-0 flex-1 rounded-[var(--fd-radius-md)] border border-border-default bg-surface-2 px-2 text-[length:var(--fd-text-sm)] text-fg-primary placeholder:text-fg-muted"
                />
                <button
                  type="submit"
                  disabled={!newBranchName.trim()}
                  className="fd-focus inline-flex h-7 items-center rounded-[var(--fd-radius-md)] bg-accent-dim px-2 text-[length:var(--fd-text-xs)] text-accent disabled:opacity-50"
                >
                  Create
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-left text-[length:var(--fd-text-sm)] text-fg-primary transition-colors hover:bg-surface-2"
              >
                <Plus aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                Create and checkout new branch…
              </button>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

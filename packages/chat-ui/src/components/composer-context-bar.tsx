import { memo, useEffect, useMemo, useState, type FormEvent } from 'react'
import * as Popover from '@radix-ui/react-popover'
import {
  Check,
  FolderClosed,
  GitBranch,
  Globe,
  Laptop,
  Plus,
  Split,
} from 'lucide-react'

import {
  filterOptionsByQuery,
  SEARCHABLE_OPTION_THRESHOLD,
  type GitBranchesResponse,
  type ThreadIsolation,
  type WorkspaceSummary,
} from '@falcondeck/client-core'
import { ActivityDiamond, Select, SelectContent, SelectItem, SelectTrigger, cn } from '@falcondeck/ui'

import { OptionFilterField } from './option-filter-field'
import type { WorkspaceHostBadge } from './workspace-group'

export type ComposerRemoteHostOption = {
  id: string
  name: string
  /** False when the host is enrolled but not currently reachable. */
  connected: boolean
}

export type ComposerContextBarProps = {
  workspaces: WorkspaceSummary[]
  selectedWorkspace: WorkspaceSummary | null
  onSelectWorkspace: (workspaceId: string) => void
  /** Increment to open the project picker from a host-level keyboard shortcut. */
  projectMenuRequestKey?: number
  /** Human-readable shortcut rendered in the project chip tooltip. */
  projectShortcutLabel?: string
  selectedIsolation: ThreadIsolation
  onIsolationChange: (value: ThreadIsolation) => void
  /** Branch state of the project folder; null hides the chip (remote host, not a repo). */
  branches?: GitBranchesResponse | null
  /** Changed-file count of the current checkout, shown under the active branch. */
  uncommittedCount?: number | null
  onCheckoutBranch?: (branch: string, create: boolean) => void | Promise<void>
  isCheckoutPending?: boolean
  disabled?: boolean
  /**
   * Host badges for workspaces that live on enrolled remote servers,
   * keyed by workspace id. Local workspaces omit an entry.
   */
  workspaceHosts?: Record<string, WorkspaceHostBadge>
  /** Enrolled remote hosts offered by "New remote project". */
  remoteHosts?: ComposerRemoteHostOption[]
  /** Opens the local folder picker and connects the path on this machine. */
  onAddLocalProject?: () => void | Promise<void>
  /**
   * Connects an absolute path on the given remote host. The menu collects host
   * + path; the host app performs the RPC and selects the new workspace.
   */
  onAddRemoteProject?: (hostId: string, path: string) => void | Promise<void>
  /** True while a local or remote project connect is in flight. */
  isAddingProject?: boolean
}

const CHIP_CLASS =
  'fd-focus inline-flex h-7 max-w-56 items-center gap-1.5 rounded-[var(--fd-radius-md)] px-2 text-[length:var(--fd-text-xs)] text-fg-secondary transition-colors duration-[var(--fd-duration-fast)] hover:bg-surface-3 hover:text-fg-primary disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:bg-surface-3 data-[state=open]:text-fg-primary'

const MENU_ITEM_CLASS =
  'fd-focus-fill flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-left text-[length:var(--fd-text-sm)] text-fg-primary transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60'

function projectName(path: string) {
  return path.split('/').filter(Boolean).pop() || path
}

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
  projectMenuRequestKey = 0,
  projectShortcutLabel,
  selectedIsolation,
  onIsolationChange,
  branches = null,
  uncommittedCount = null,
  onCheckoutBranch,
  isCheckoutPending = false,
  disabled = false,
  workspaceHosts = {},
  remoteHosts = [],
  onAddLocalProject,
  onAddRemoteProject,
  isAddingProject = false,
}: ComposerContextBarProps) {
  const selectedHost = selectedWorkspace
    ? workspaceHosts[selectedWorkspace.id] ?? null
    : null
  const projectLabel = selectedWorkspace
    ? projectName(selectedWorkspace.path)
    : 'Select a project'

  return (
    <div className="relative z-0 mx-3 -mb-3 flex items-center gap-0.5 rounded-t-[var(--fd-radius-xl)] border border-b-0 border-border-subtle bg-surface-3/60 px-2 pb-4 pt-1.5">
      <ProjectMenu
        workspaces={workspaces}
        selectedWorkspace={selectedWorkspace}
        projectLabel={projectLabel}
        selectedHost={selectedHost}
        workspaceHosts={workspaceHosts}
        remoteHosts={remoteHosts}
        onSelectWorkspace={onSelectWorkspace}
        openRequestKey={projectMenuRequestKey}
        shortcutLabel={projectShortcutLabel}
        onAddLocalProject={onAddLocalProject}
        onAddRemoteProject={onAddRemoteProject}
        isAddingProject={isAddingProject}
        disabled={disabled}
      />

      {/* Location chip: Local vs the remote host name (ChatGPT-style). */}
      <span
        className={cn(
          CHIP_CLASS,
          'max-w-40 cursor-default hover:bg-transparent hover:text-fg-secondary',
        )}
        title={
          selectedHost
            ? selectedHost.connected
              ? `Runs on ${selectedHost.name}`
              : `${selectedHost.name} is offline`
            : 'Runs on this Mac'
        }
      >
        {selectedHost ? (
          <Globe aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
        ) : (
          <Laptop aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
        )}
        <span className="truncate">{selectedHost ? selectedHost.name : 'Local'}</span>
        {selectedHost ? (
          <span
            aria-hidden="true"
            className={cn(
              'ml-0.5 h-1.5 w-1.5 shrink-0 rounded-full',
              selectedHost.connected ? 'bg-success' : 'bg-fg-muted',
            )}
          />
        ) : null}
      </span>

      <Select
        value={selectedIsolation}
        onValueChange={(next) => onIsolationChange(next as ThreadIsolation)}
        disabled={disabled}
      >
        <SelectTrigger variant="quiet" aria-label="Work in" className={CHIP_CLASS}>
          {selectedIsolation === 'isolated' ? (
            <Split aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
          ) : (
            <FolderClosed aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
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

type ProjectMenuPanel = 'list' | 'pick-host' | 'remote-path'

function ProjectMenu({
  workspaces,
  selectedWorkspace,
  projectLabel,
  selectedHost,
  workspaceHosts,
  remoteHosts,
  onSelectWorkspace,
  openRequestKey,
  shortcutLabel,
  onAddLocalProject,
  onAddRemoteProject,
  isAddingProject,
  disabled,
}: {
  workspaces: WorkspaceSummary[]
  selectedWorkspace: WorkspaceSummary | null
  projectLabel: string
  selectedHost: WorkspaceHostBadge | null
  workspaceHosts: Record<string, WorkspaceHostBadge>
  remoteHosts: ComposerRemoteHostOption[]
  onSelectWorkspace: (workspaceId: string) => void
  openRequestKey: number
  shortcutLabel?: string
  onAddLocalProject?: () => void | Promise<void>
  onAddRemoteProject?: (hostId: string, path: string) => void | Promise<void>
  isAddingProject: boolean
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [panel, setPanel] = useState<ProjectMenuPanel>('list')
  const [remoteHostId, setRemoteHostId] = useState<string | null>(null)
  const [remotePath, setRemotePath] = useState('')
  const [remoteError, setRemoteError] = useState<string | null>(null)

  useEffect(() => {
    if (openRequestKey > 0 && !disabled) setOpen(true)
  }, [disabled, openRequestKey])

  const connectedRemoteHosts = useMemo(
    () => remoteHosts.filter((host) => host.connected),
    [remoteHosts],
  )
  const canAddRemote =
    Boolean(onAddRemoteProject) && connectedRemoteHosts.length > 0
  const searchable = workspaces.length >= SEARCHABLE_OPTION_THRESHOLD
  const visibleWorkspaces = useMemo(
    () =>
      searchable
        ? filterOptionsByQuery(workspaces, query, (workspace) => {
            const host = workspaceHosts[workspace.id]
            return `${workspace.path} ${workspace.id} ${host?.name ?? 'local'}`
          })
        : workspaces,
    [query, searchable, workspaceHosts, workspaces],
  )

  const resetAddFlow = () => {
    setPanel('list')
    setRemoteHostId(null)
    setRemotePath('')
    setRemoteError(null)
  }

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) {
      setQuery('')
      resetAddFlow()
    }
  }

  const startRemoteAdd = () => {
    setRemoteError(null)
    setRemotePath('')
    if (connectedRemoteHosts.length === 1) {
      setRemoteHostId(connectedRemoteHosts[0]!.id)
      setPanel('remote-path')
      return
    }
    setRemoteHostId(null)
    setPanel('pick-host')
  }

  const submitRemotePath = async (event: FormEvent) => {
    event.preventDefault()
    const path = remotePath.trim()
    const hostId = remoteHostId
    if (!path || !hostId || !onAddRemoteProject) return
    if (!path.startsWith('/')) {
      setRemoteError('Enter an absolute path on the server, e.g. /home/forge/projects/app')
      return
    }
    setRemoteError(null)
    try {
      await onAddRemoteProject(hostId, path)
      setOpen(false)
      resetAddFlow()
    } catch (error) {
      setRemoteError(error instanceof Error ? error.message : 'Failed to add project')
    }
  }

  const selectedRemoteHost = remoteHosts.find((host) => host.id === remoteHostId) ?? null
  const ProjectIcon = selectedHost ? Globe : FolderClosed
  const menuDisabled = disabled || (workspaces.length === 0 && !onAddLocalProject && !canAddRemote)

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label="Project"
          aria-haspopup="menu"
          aria-expanded={open}
          title={shortcutLabel ? `Change project (${shortcutLabel})` : 'Change project'}
          disabled={menuDisabled}
          className={CHIP_CLASS}
        >
          <ProjectIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
          <span className="truncate">{projectLabel}</span>
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 w-80 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-1 shadow-[var(--fd-shadow-lg)]"
        >
          {panel === 'list' ? (
            <>
              <p className="px-2.5 pb-1 pt-1.5 text-[length:var(--fd-text-2xs)] font-medium uppercase tracking-[0.08em] text-fg-muted">
                Projects
              </p>
              {searchable ? (
                <OptionFilterField
                  value={query}
                  onChange={setQuery}
                  label="Search projects"
                  resultCount={visibleWorkspaces.length}
                  autoFocus
                />
              ) : null}
              <div role="menu" className="max-h-64 overflow-y-auto">
                {visibleWorkspaces.map((workspace) => {
                  const label = projectName(workspace.path)
                  const host = workspaceHosts[workspace.id]
                  const selected = workspace.id === selectedWorkspace?.id
                  const Icon = host ? Globe : FolderClosed
                  const accessibleName = host ? `${label} ${host.name}` : label
                  return (
                    <button
                      key={workspace.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={selected}
                      aria-label={accessibleName}
                      onClick={() => {
                        onSelectWorkspace(workspace.id)
                        setOpen(false)
                      }}
                      className={MENU_ITEM_CLASS}
                    >
                      <Icon
                        aria-hidden="true"
                        className={cn(
                          'h-3.5 w-3.5 shrink-0',
                          host ? 'text-accent' : 'text-fg-muted',
                          host && !host.connected && 'opacity-60',
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate font-medium">{label}</span>
                          {host ? (
                            <span className="truncate text-[length:var(--fd-text-xs)] text-fg-muted">
                              {host.name}
                            </span>
                          ) : null}
                        </span>
                        <span className="block truncate text-[length:var(--fd-text-xs)] text-fg-muted">
                          {workspace.path}
                        </span>
                      </span>
                      {selected ? (
                        <Check aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
                      ) : null}
                    </button>
                  )
                })}
                {visibleWorkspaces.length === 0 ? (
                  <p className="px-2.5 py-3 text-center text-[length:var(--fd-text-sm)] text-fg-muted">
                    {query.trim()
                      ? `No projects match “${query.trim()}”`
                      : 'No projects yet'}
                  </p>
                ) : null}
              </div>
              {onAddLocalProject || canAddRemote || remoteHosts.length > 0 ? (
                <div className="mt-1 border-t border-border-subtle pt-1">
                  {canAddRemote ? (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={isAddingProject}
                      onClick={startRemoteAdd}
                      className={MENU_ITEM_CLASS}
                    >
                      <Globe aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                      <span>New remote project</span>
                    </button>
                  ) : remoteHosts.length > 0 && onAddRemoteProject ? (
                    <p className="px-2.5 py-1.5 text-[length:var(--fd-text-xs)] text-fg-muted">
                      Connect a server in Settings to add a remote project.
                    </p>
                  ) : null}
                  {onAddLocalProject ? (
                    <button
                      type="button"
                      role="menuitem"
                      disabled={isAddingProject}
                      onClick={() => {
                        void onAddLocalProject()
                        setOpen(false)
                      }}
                      className={MENU_ITEM_CLASS}
                    >
                      {isAddingProject ? (
                        <ActivityDiamond size="md" tone="current" />
                      ) : (
                        <Plus aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                      )}
                      <span>New project</span>
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : null}

          {panel === 'pick-host' ? (
            <>
              <div className="flex items-center justify-between px-2.5 pb-1 pt-1.5">
                <p className="text-[length:var(--fd-text-2xs)] font-medium uppercase tracking-[0.08em] text-fg-muted">
                  Server
                </p>
                <button
                  type="button"
                  className="text-[length:var(--fd-text-xs)] text-fg-muted hover:text-fg-primary"
                  onClick={resetAddFlow}
                >
                  Back
                </button>
              </div>
              <div role="menu">
                {connectedRemoteHosts.map((host) => (
                  <button
                    key={host.id}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setRemoteHostId(host.id)
                      setPanel('remote-path')
                    }}
                    className={MENU_ITEM_CLASS}
                  >
                    <Globe aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-accent" />
                    <span className="min-w-0 flex-1 truncate">{host.name}</span>
                    <span
                      aria-hidden="true"
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-success"
                    />
                  </button>
                ))}
              </div>
            </>
          ) : null}

          {panel === 'remote-path' ? (
            <form onSubmit={(event) => void submitRemotePath(event)} className="space-y-2 p-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[length:var(--fd-text-2xs)] font-medium uppercase tracking-[0.08em] text-fg-muted">
                  Path on {selectedRemoteHost?.name ?? 'server'}
                </p>
                <button
                  type="button"
                  className="text-[length:var(--fd-text-xs)] text-fg-muted hover:text-fg-primary"
                  onClick={() => {
                    if (connectedRemoteHosts.length > 1) {
                      setPanel('pick-host')
                      setRemotePath('')
                      setRemoteError(null)
                    } else {
                      resetAddFlow()
                    }
                  }}
                >
                  Back
                </button>
              </div>
              <input
                autoFocus
                value={remotePath}
                onChange={(event) => {
                  setRemotePath(event.target.value)
                  if (remoteError) setRemoteError(null)
                }}
                placeholder="/home/forge/projects/my-app"
                aria-label="Remote project path"
                className="fd-focus h-8 w-full rounded-[var(--fd-radius-md)] border border-border-default bg-surface-2 px-2 text-[length:var(--fd-text-sm)] text-fg-primary placeholder:text-fg-muted"
              />
              {remoteError ? (
                <p className="text-[length:var(--fd-text-xs)] text-danger">{remoteError}</p>
              ) : (
                <p className="text-[length:var(--fd-text-xs)] text-fg-muted">
                  Absolute folder path on the server. Agents run there over the relay.
                </p>
              )}
              <button
                type="submit"
                disabled={isAddingProject || !remotePath.trim() || !remoteHostId}
                className="fd-focus inline-flex h-8 w-full items-center justify-center gap-2 rounded-[var(--fd-radius-md)] bg-accent-dim px-2 text-[length:var(--fd-text-sm)] text-accent disabled:opacity-50"
              >
                {isAddingProject ? <ActivityDiamond size="md" tone="current" /> : null}
                Add project
              </button>
            </form>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

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
  const [query, setQuery] = useState('')
  const searchable = branches.branches.length >= SEARCHABLE_OPTION_THRESHOLD
  const visibleBranches = useMemo(
    () =>
      searchable
        ? filterOptionsByQuery(branches.branches, query, (branch) => branch)
        : branches.branches,
    [branches.branches, query, searchable],
  )

  // A fresh open always starts on the list, not a stale half-typed name.
  useEffect(() => {
    if (!open) {
      setCreating(false)
      setNewBranchName('')
      setQuery('')
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
        <button
          type="button"
          aria-label="Git branch"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          className={CHIP_CLASS}
        >
          {isCheckoutPending ? (
            <ActivityDiamond className="text-fg-muted" tone="current" />
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
          {searchable && !creating ? (
            <OptionFilterField
              value={query}
              onChange={setQuery}
              label="Search branches"
              resultCount={visibleBranches.length}
              autoFocus
            />
          ) : null}
          <div role="menu" className="max-h-64 overflow-y-auto">
            {visibleBranches.map((branch) => {
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
                  className={cn(MENU_ITEM_CLASS)}
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
            {visibleBranches.length === 0 ? (
              <p className="px-2.5 py-3 text-center text-[length:var(--fd-text-sm)] text-fg-muted">
                No branches match “{query.trim()}”
              </p>
            ) : null}
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
                className={MENU_ITEM_CLASS}
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

import { memo, useState } from "react";
import * as Popover from "@radix-ui/react-popover";
import { FolderClosed, FolderPlus } from "lucide-react";

import { projectLabel, type LibraryWorkspace } from "@falcondeck/client-core";
import { ActivityDiamond, Tooltip, cn } from "@falcondeck/ui";

const MAX_RECENTS = 8;

/**
 * Add-project control that offers closed projects before the folder picker,
 * matching Finder's "add a favorite" recents.
 */
export const AddProjectMenu = memo(function AddProjectMenu({
  libraryWorkspaces,
  onOpenLibraryWorkspace,
  onAddProject,
  isAddingProject,
  shortcut,
}: {
  libraryWorkspaces: readonly LibraryWorkspace[];
  onOpenLibraryWorkspace: (path: string) => Promise<void> | void;
  onAddProject: () => void;
  isAddingProject: boolean;
  shortcut?: string[];
}) {
  const [open, setOpen] = useState(false);
  const recents = libraryWorkspaces
    .filter((workspace) => workspace.kind !== "casual")
    .slice(0, MAX_RECENTS);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Tooltip label="Add project" shortcut={shortcut}>
        <Popover.Trigger asChild>
          <button
            type="button"
            className={cn(
              "fd-focus -my-0.5 shrink-0 rounded-[var(--fd-radius-sm)] p-0.5 text-fg-muted transition-colors duration-[var(--fd-duration-fast)] hover:bg-surface-3 hover:text-fg-secondary disabled:pointer-events-none disabled:opacity-40",
              open && "bg-surface-3 text-fg-secondary",
            )}
            disabled={isAddingProject}
            aria-label="Add project"
            aria-busy={isAddingProject}
          >
            {isAddingProject ? (
              <ActivityDiamond size="sm" tone="current" />
            ) : (
              <FolderPlus aria-hidden="true" className="h-3.5 w-3.5" />
            )}
          </button>
        </Popover.Trigger>
      </Tooltip>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          className="z-50 w-64 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-1 p-1 shadow-[var(--fd-shadow-lg)]"
        >
          <div role="menu" aria-label="Add project">
            {recents.length > 0 ? (
              <p className="px-2.5 pb-1 pt-1.5 text-[length:var(--fd-text-2xs)] font-medium uppercase tracking-[0.08em] text-fg-muted">
                Recent
              </p>
            ) : null}
            {recents.map((workspace) => {
              const label = projectLabel(workspace.path);
              return (
                <button
                  key={workspace.id}
                  type="button"
                  role="menuitem"
                  title={workspace.path}
                  onClick={() => {
                    setOpen(false);
                    void onOpenLibraryWorkspace(workspace.path);
                  }}
                  className="fd-focus flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-left text-[length:var(--fd-text-sm)] text-fg-secondary hover:bg-surface-3 hover:text-fg-primary"
                >
                  <FolderClosed
                    aria-hidden="true"
                    className="h-3.5 w-3.5 shrink-0 text-fg-muted"
                  />
                  <span className="min-w-0 truncate">{label}</span>
                </button>
              );
            })}
            {recents.length > 0 ? (
              <div
                role="separator"
                className="mx-2 my-1 border-t border-border-subtle"
              />
            ) : null}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onAddProject();
              }}
              className="fd-focus flex w-full items-center gap-2 rounded-[var(--fd-radius-md)] px-2.5 py-1.5 text-left text-[length:var(--fd-text-sm)] text-fg-secondary hover:bg-surface-3 hover:text-fg-primary"
            >
              <FolderPlus
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-fg-muted"
              />
              Open other folder…
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
});

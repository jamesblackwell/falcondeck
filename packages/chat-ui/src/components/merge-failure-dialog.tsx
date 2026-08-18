import { useEffect, useId, useRef } from 'react'
import { createPortal } from 'react-dom'
import { CircleAlert, ShieldCheck, TriangleAlert, X } from 'lucide-react'

import { Button } from '@falcondeck/ui'

type MergeFailurePresentation = {
  title: string
  summary: string
  nextStep: string
  paths: string[]
  stoppedBeforeMerge: boolean
}

function untrackedPaths(message: string): string[] | null {
  const lines = message.split(/\r?\n/)
  const start = lines.findIndex((line) =>
    /following untracked working tree files would be overwritten by merge/i.test(line),
  )
  if (start < 0) return null

  const paths: string[] = []
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (
      /^(?:please move or remove them before you merge|aborting|merge with strategy)/i.test(
        trimmed,
      )
    ) {
      break
    }
    paths.push(trimmed)
  }
  return paths
}

export function describeMergeFailure(
  message: string,
  baseBranch: string,
): MergeFailurePresentation {
  const paths = untrackedPaths(message)
  if (paths) {
    return {
      title: `${baseBranch} contains files that would be overwritten`,
      summary:
        'The main project folder contains files Git is not tracking at paths that also exist in the isolated branch. Git refused to replace them.',
      nextStep:
        'Review the files below in the main project folder. Move or rename anything you want to keep, or remove files you know are generated or disposable. Then try Merge and push again.',
      paths,
      stoppedBeforeMerge: true,
    }
  }

  if (/project folder has uncommitted changes/i.test(message)) {
    return {
      title: `${baseBranch} has uncommitted changes`,
      summary:
        'FalconDeck will not merge into the main project folder while it contains work that has not been committed.',
      nextStep:
        'Commit, stash, or move those changes in the main project folder, then try Merge and push again.',
      paths: [],
      stoppedBeforeMerge: true,
    }
  }

  if (/project folder is not on .+switch to it first/i.test(message)) {
    return {
      title: `${baseBranch} is not checked out`,
      summary: `The main project folder must be on ${baseBranch} before FalconDeck can merge this isolated branch into it.`,
      nextStep: `Switch the main project folder to ${baseBranch}, then try Merge and push again.`,
      paths: [],
      stoppedBeforeMerge: true,
    }
  }

  if (/\bconflict\b|automatic merge failed/i.test(message)) {
    return {
      title: 'The merge has conflicts',
      summary:
        'Git started the merge but could not combine every change automatically. The main project folder may now contain unresolved files.',
      nextStep:
        'Resolve or abort the merge in the main project folder before trying Merge and push again.',
      paths: [],
      stoppedBeforeMerge: false,
    }
  }

  return {
    title: 'FalconDeck could not complete the merge',
    summary:
      'Git reported a problem while merging the isolated branch into the main project folder.',
    nextStep:
      'Review the technical details below and check the main project folder before trying again.',
    paths: [],
    stoppedBeforeMerge: false,
  }
}

type MergeFailureDialogProps = {
  message: string
  branch: string
  baseBranch: string
  onDismiss: () => void
}

export function MergeFailureDialog({
  message,
  branch,
  baseBranch,
  onDismiss,
}: MergeFailureDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const presentation = describeMergeFailure(message, baseBranch)

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    closeButtonRef.current?.focus()
    return () => previouslyFocused?.focus()
  }, [])

  if (typeof document === 'undefined') return null

  return createPortal(
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center overflow-y-auto bg-[var(--fd-overlay)] p-4 sm:p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onDismiss()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          onDismiss()
          return
        }
        if (event.key !== 'Tab') return

        const focusable = Array.from(
          dialogRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])',
          ) ?? [],
        )
        const first = focusable[0]
        const last = focusable.at(-1)
        if (!first || !last) return
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-xl flex-col overflow-hidden rounded-[var(--fd-radius-xl)] border border-border-default bg-surface-1 shadow-[var(--fd-shadow-xl)]"
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-border-subtle px-5 py-4">
          <span className="mt-0.5 rounded-[var(--fd-radius-lg)] bg-warning-muted p-2 text-warning">
            <TriangleAlert aria-hidden="true" className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="fd-microlabel text-warning">Merge blocked</p>
            <h2
              id={titleId}
              className="mt-1 text-[length:var(--fd-text-lg)] font-semibold text-fg-primary"
            >
              {presentation.title}
            </h2>
            <p className="mt-1 break-all font-mono text-[length:var(--fd-text-xs)] text-fg-muted">
              {branch} → {baseBranch}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close merge error"
            onClick={onDismiss}
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <p
            id={descriptionId}
            className="text-[length:var(--fd-text-sm)] leading-[var(--fd-leading-relaxed)] text-fg-secondary"
          >
            {presentation.summary}
          </p>

          <div className="mt-4 flex items-start gap-2.5 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2 px-3 py-2.5">
            {presentation.stoppedBeforeMerge ? (
              <ShieldCheck
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0 text-success"
              />
            ) : (
              <CircleAlert
                aria-hidden="true"
                className="mt-0.5 h-4 w-4 shrink-0 text-warning"
              />
            )}
            <p className="text-[length:var(--fd-text-xs)] leading-[var(--fd-leading-normal)] text-fg-secondary">
              {presentation.stoppedBeforeMerge
                ? `Git stopped before changing ${baseBranch}. Nothing was merged or pushed.`
                : 'Nothing was pushed. Check the main project folder before trying the merge again.'}
            </p>
          </div>

          <section className="mt-5">
            <h3 className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
              What to do
            </h3>
            <p className="mt-1 text-[length:var(--fd-text-sm)] leading-[var(--fd-leading-relaxed)] text-fg-secondary">
              {presentation.nextStep}
            </p>
          </section>

          {presentation.paths.length > 0 ? (
            <section className="mt-5">
              <div className="mb-2 flex items-baseline justify-between gap-3">
                <h3 className="text-[length:var(--fd-text-sm)] font-medium text-fg-primary">
                  Blocking files
                </h3>
                <span className="text-[length:var(--fd-text-xs)] text-fg-muted">
                  {presentation.paths.length}{' '}
                  {presentation.paths.length === 1 ? 'file' : 'files'}
                </span>
              </div>
              <ul className="max-h-56 overflow-y-auto rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-0 py-1 font-mono text-[length:var(--fd-text-xs)] text-fg-secondary">
                {presentation.paths.map((path) => (
                  <li
                    key={path}
                    className="break-all border-b border-border-subtle px-3 py-1.5 last:border-b-0"
                  >
                    {path}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <details className="mt-5 rounded-[var(--fd-radius-lg)] border border-border-subtle bg-surface-2">
            <summary className="fd-focus-inset cursor-pointer rounded-[var(--fd-radius-lg)] px-3 py-2 text-[length:var(--fd-text-xs)] font-medium text-fg-secondary hover:text-fg-primary">
              Technical details
            </summary>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words border-t border-border-subtle px-3 py-2 font-mono text-[length:var(--fd-text-xs)] leading-[var(--fd-leading-normal)] text-fg-muted">
              {message}
            </pre>
          </details>
        </div>

        <footer className="flex shrink-0 justify-end border-t border-border-subtle px-5 py-3">
          <Button ref={closeButtonRef} type="button" onClick={onDismiss}>
            Close
          </Button>
        </footer>
      </div>
    </div>,
    document.body,
  )
}

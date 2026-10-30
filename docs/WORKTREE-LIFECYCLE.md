# Worktree lifecycle and disk hygiene

Status: shipped 2026-10-30. Design background is in `WORKTREES.md`.

## Why this exists

An isolated thread gets a variant: a `git worktree` under
`~/.falcondeck/variants/<project>/<slug>/` on branch `falcondeck/<slug>`
(`crates/falcondeck-daemon/src/variant.rs`). A Quizgecko worktree is about
2 GB once dependencies are installed. On 30 Oct 2026 the variants directory
held 91 GB across 55 checkouts and the Mac had 11 GB free.

The leak had one cause: **archiving a thread only set `is_archived`**.
Only `delete_thread` removed the checkout, and people archive far more than
they delete. `WORKTREES.md` promised "archiving offers variant cleanup" but
it was never built. Other worktrees (Codex under `~/.codex/worktrees`, ad-hoc
`/private/tmp` checkouts) have no FalconDeck owner at all.

## What removes a variant now

| Event | Behaviour |
|---|---|
| Thread deleted | Checkout force-removed (unchanged). The branch is kept. |
| Thread archived (single or "archive all") | The daemon tries `reclaim_if_safe` in the background. Safe: checkout removed, branch kept. Not safe: checkout kept and the reasons are logged (`kept isolated copy of archived thread`). |
| Thread unarchived | If the checkout was reclaimed, it is recreated at the same path from the kept branch (`git worktree add <path> <branch>`) and the env-file allowlist is copied again. |
| Anything else (idle threads, no owner) | `scripts/worktree-gc.mjs`. Never automatic. |

Threads that are running, waiting for input, or have queued turns are skipped.
Open (unarchived) threads are never reclaimed: their working directory must
exist to resume them.

There is deliberately no background sweep of the existing backlog: the first
deletion run over old worktrees is a human decision made with the dry-run
table in front of them.

## The SAFE rules

A checkout is reclaimed only if all of these hold. The daemon
(`variant/reclaim.rs`) and the script (`scripts/worktree-gc.mjs`) implement
the same rules; change them together.

1. `git status` is clean. Untracked files block, except allowlisted env files
   (`.env*`, `.envrc`, `*.local.*`) that are byte-identical to the project
   folder's copy.
2. Every commit is on `origin`. A commit counts when its SHA is reachable from
   a live `origin` branch, or when `git cherry` finds a patch-equivalent commit
   on the default branch or the same-named branch (rebased and cherry-picked
   copies count; squash merges do not, and are kept).
3. Ignored files are limited to rebuildable directories (`node_modules`,
   `vendor`, `target`, `.next`, `dist`) and allowlisted env-file copies (the
   daemon put them there; the original is in the project folder).
4. `git worktree remove` is run without `--force`, so git re-checks
   cleanliness itself. The script additionally requires the checkout to be
   older than 3 days and its owner thread not running.

The remote is read live with `git ls-remote`, and the objects behind the tips
are fetched into a scratch object directory (`GIT_OBJECT_DIRECTORY`, with the
repo's objects as alternates). No refs, `FETCH_HEAD`, config or index of the
inspected repository are written. If the remote cannot be reached, nothing is
reclaimed.

Known gap: the strict rebuildable list keeps most Quizgecko worktrees, because
they carry framework caches (`.phpunit.cache`, `bootstrap/cache`,
`storage/framework`, `.react-router`). `worktree-gc --rebuildable-preset
generated` shows the effect of widening it; widening is one constant in each
implementation (`GENERATED_PRESET` / `REBUILDABLE`).

## The cleanup script

```sh
node scripts/worktree-gc.mjs                       # dry run (default)
node scripts/worktree-gc.mjs --format markdown     # report for sharing
node scripts/worktree-gc.mjs --apply               # remove SAFE only
node scripts/disk-hogs.mjs --top 10                # other big consumers, read-only
```

It lists every worktree under `~/.falcondeck/variants`, `~/.codex/worktrees`
and `/private/tmp`, with path, repo, size, last activity, clean/dirty,
unpushed commits, non-rebuildable ignored files and the owning thread, and
classes each:

- **ACTIVE**: thread running, a process has its cwd inside, or modified in
  the last 24 h.
- **SAFE**: the rules above and older than 3 days.
- **REVIEW**: everything else, with the reasons.

`--apply` removes SAFE worktrees with `git worktree remove` (never `--force`,
never `rm -rf`), then `git worktree prune`. It re-assesses each entry just
before removing it, skips standalone clones, and skips SAFE worktrees whose
thread is still open unless `--include-open-threads` is given (removing them
breaks resuming the thread until the daemon restores the copy). Every run
writes an audit log to `~/.falcondeck/worktree-gc/` with each removed path,
branch and HEAD sha. Branches are kept, so removal is recoverable.

"Last activity" is the newest of the git metadata (HEAD, index, reflog),
modified tracked/untracked files, and the owning thread's `updated_at`. The
checkout root's own mtime is only used when no thread owns the copy, because
other tools touch it.

## Follow-ups (not built)

- Surface retained copies in the UI ("kept because 3 commits are unpushed").
  Needs a design packet.
- Reclaim idle open threads after N days, which also needs restore on turn
  start, not only on unarchive.
- Run the script on a schedule once the first manual run has been approved.

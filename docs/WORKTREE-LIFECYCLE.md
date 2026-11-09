# Worktree lifecycle and disk hygiene

An isolated thread owns a Git worktree and branch under
`~/.falcondeck/variants/<project>/<slug>/`. Checkout reclamation retains the
thread, its native agent history, variant metadata, and branch.

## Per-project setup

Full checkouts without copied dependencies remain the default. Opt in using a
repository-local Git setting pointing to an external JSON file:

```sh
git config --local falcondeck.worktreeSetup /absolute/path/to/worktree-setup.json
```

Example:

```json
{
  "sparse_exclude": [
    "data/qbank", "docs/research", "docs/marketing", "docs/help-center"
  ],
  "dependency_roots": ["frontend"],
  "sparse_hint": "QBank and Curriculum services import data/qbank. Before working on those services, run git sparse-checkout add /data/qbank/."
}
```

Only local Git configuration is read; a global or command-scope setting cannot
silently enable this for every project. Paths must be relative directories;
`"."` is allowed as a dependency root. The daemon has no Quizgecko-specific
sparse policy. The example keeps `docs/reports` and `docs/development`, including
gate receipts.

Sparse checkout uses **non-cone exclusions**, starting with `/*`, then patterns
such as `!/data/qbank/`. New directories outside the exclusions are included
automatically. This avoids frozen cones silently omitting new `docs/*` and
`data/*` directories during add, commit, or merge.

Each coding turn receives an explanation of missing directories and how to add
them back:

```sh
git sparse-checkout add /data/qbank/  # include this subtree after its exclusion
git sparse-checkout disable          # materialize the full tree
```

Before managed reclamation, both the daemon and GC script save the worktree's
actual sparse patterns under the shared Git directory's `falcondeck-variants/`.
Restore uses that recipe, including paths added back or a disabled sparse mode.
A variant created full stays full even if the project defaults subsequently
change. Legacy variants without a saved recipe also restore full. External
removal that bypasses managed reclamation cannot capture subsequent manual
pattern edits; the last saved recipe is the recovery point.

Git's worktree-specific sparse configuration does not change the main or other
worktrees' checkout selection. Tests cover full main/existing variants, a sparse
main with a new full variant, new directories, commit-all, merge, and add-back.

## Creation and restore

Tracked-file provisioning is transactional:

1. Validate setup and, on restore, verify the kept branch still exists.
2. `git worktree add --no-checkout` at a private sibling staging path, then
   initialize its index with `git read-tree HEAD`.
3. Apply the saved sparse selection and check out HEAD.
4. Verify the checkout is populated, copy the environment-file allowlist, and
   save its recipe.
5. Publish with `git worktree move` to the thread's final path.
6. Start optional dependency cloning in the background.

Only an unpublished staging worktree created in the current call can be
force-removed during rollback;
this is not the reclamation path. Failed creation also drops its newly created
branch. A pre-existing branch is never treated as a creation rollback target.
After a crash, create/restore recover only that slug's registered
`.slug-provision-<uuid>` staging worktree. They reuse its branch, finish setup,
and move it into place, so neither staging nor a duplicate branch is left
behind. Recovery first verifies the exact branch and tip, an index matching
HEAD, and no hidden index flags, `index.lock` in its own Git directory, or
operation in progress, even when only `.git`
exists on disk. Staged edits, additions and deletions are retained with a clear
review error. An uninitialized index that does not match HEAD is also retained;
filesystem emptiness alone is never proof of safety. Populated staging must
additionally have no working-tree edits, and live processes block recovery.
A provisioning failure in recovered staging always retains that checkout and
branch with a clear review error; rollback never force-removes pre-existing
staging. Other slugs and unrelated paths are untouched. This is request-time recovery,
not a backlog sweep.

An existing folder is not sufficient proof of a restored checkout: Git must
identify that folder as the worktree and a non-empty HEAD cannot have every
tracked file missing. Incomplete legacy checkouts produce an error instead of
allowing a turn or Commit to stage deletion of the entire tree. A deleted branch
produces an error naming that branch and asking for recovery from a surviving
ref; restore never substitutes main.

Unarchive reports tracked-checkout restoration failures to its caller and leaves
the thread archived. Send/resume, review, compact, Commit, Ship, and file access
restore a reclaimed checkout before using it. Mutating and file-view operations
hold the same per-thread gate as final reclamation. Expensive remote safety
verification runs outside this gate, then thread eligibility and local safety
are checked again after acquiring it.

### Dependency provisioning

For configured dependency roots, the project folder's warm pnpm install is
eligible only when package/lock inputs, npm configuration and workspace
configuration match the destination. Its installed receipt,
`node_modules/.pnpm/lock.yaml`, must match the source lock. Source inputs and the
cloned receipt are checked again before publishing. npm/yarn, absent receipts,
stale installs, mismatched restored branches, and unsupported clone operations
use the cold path: no automatic install, and a visible notice tells the agent
or user to run the project's normal install.

Files use APFS `clonefile` on macOS and `cp --reflink=always` elsewhere. There is
no full-copy fallback. Failed staging is removed. Roots cannot escape their
checkouts, and destination node_modules must be Git-ignored. Absolute and
escaping symlinks are rejected. Textual source paths in pnpm shims are relocated
at path boundaries, including source path aliases; `quizgecko-old` is not a match
for `quizgecko`. Binary source-path references reject the warm tree. Clones can
subsequently diverge without modifying the source.

Warm copies run one at a time. Their private staging lives in the worktree's
Git administrative directory, so a concurrent `git add -A` cannot commit it.
Creation and unarchive return with a populated tracked tree while dependencies
are prepared. A notice shows preparation/fallback state. Turns sent during
preparation are committed to the existing durable queue, return a clear queued
response, and wait before provider dispatch. The persisted `preparing_variant`
flag distinguishes this accepted outbox work from a turn interrupted after
provider dispatch; that flag is cleared at the dispatch boundary. Queue order
is preserved even when the existing head is held. If that flag survives a
restart without its in-memory provisioning job, recovery records an interrupted
job and shows a warning that `node_modules` may be incomplete and the project's
normal install is needed. It does not silently treat the lost job as successful.
Archiving during preparation waits for the job in the background, then checks
archive/activity and every safety rule again; unarchive or new activity cancels
that removal attempt.

## Reclamation

| Event | Behaviour |
|---|---|
| Archive (single/all) | Attempt safe reclamation in the background. |
| Successful live turn completion | Update task activity; daily policy uses 3/14-day idle thresholds. |
| Periodic maintenance | Check free disk every five minutes; run the configured daily storage policy. |
| Resume/unarchive or checkout access | Restore missing checkout from the kept branch/recipe. |
| Delete thread/workspace | Return without waiting for remote cleanup; safe cleanup runs in the background. |
| Daemon startup | Restore settings/run log; daily policy includes managed variants after fresh safety checks. |

### Daily daemon storage policy

A five-minute maintenance tick measures free space independently of cleanup.
It starts at most one daemon-owned cleanup worker per day, using a durable
`storage-last-scheduled.json` start time independent of manual/archive runs. This is a zero-token daemon job, not an agent
automation. A restart does not replay a daily run already started. The daily
policy intentionally inventories the existing managed backlog; the measured
9 November dry run and its expected first-run savings are recorded in
[the storage audit](reports/2026-11-09-storage-audit.md).

`storage-preferences.json` has separate switches for the schedule, cache cleanup,
checkout reclamation, aged artifact deletion, aged experiment deletion and
warnings. Scheduled cache cleanup and reclamation default on; aged artifact and
experiment deletion default off. Disabling the schedule leaves explicit,
confirmed “Clean up now” available. Disabling reclamation also disables the
archive-triggered background attempt. Invalid persisted settings fail closed.
Old successful-completion eligibility markers are retained for state compatibility;
the production timer no longer uses their 72-hour policy.

- Only managed Git worktree variants are eligible. Main project checkouts,
  shared paths, standalone clones, symlink roots and symlink ancestors stay.
- Running, waiting, queued and dispatching tasks stay. Both task activity and
  recursive filesystem modification time must be more than 24 hours old, including
  the worktree-specific HEAD, index and HEAD reflog.
- Dirty variants stay, including untracked files and hidden index flags. Storage
  shows these tasks for opening, with no deletion buttons.
- After more than 3 idle days, remove only known ecosystem cache directories
  which Git ignores and which contain no tracked files: `node_modules`,
  `DerivedData`, `.next`, `.nuxt`, `.turbo`, Python/PHP/framework caches; anchored
  `target`, `dist`, `build`, `vendor`, `.venv`, frontend/iOS/Android build roots.
  `.cache` and arbitrary `build`/`vendor` directories are not a global allowlist.
- A project may extend cache paths with a **local-only**, declarative JSON list:
  `git config --local falcondeck.storageCaches '["frontend/.cache"]'`.
  Only relative paths with no `.`/`..`/`.git` components are accepted. No project
  script is executed. Additional paths still need the same ignored/untracked,
  activity, process and age checks; configuration cannot override safety.
- Clean archived variants, or variants idle more than 14 days, use the shared
  reclamation assessment and finish path below. Live remote verification remains
  mandatory: a branch with unpushed/unmerged commits stays. Branches, task history
  and sparse recipes are retained for restore.
- Artifacts and experiments with no descendant modified within 30 days appear
  as candidates. Deletion needs the corresponding opt-in. Git repositories,
  main/managed checkout paths, symlinks, recent files and active-process paths
  stay even after opt-in; Git-containing experiments require manual review.
- Native Codex workspace databases and file logs are report-only. The job never
  deletes or compacts them, and never invokes a repository's GC apply script.

Scans and cache/artifact removal run on dedicated background-QoS threads on
macOS; Git checks/removal run at nice 10. Network work happens outside task
admission gates. Reclamation repeats state, local Git and process checks under
the task gate; cache deletion holds the same gate and rechecks before removal.
External writers which do not use daemon gates can still race filesystem checks.

The log retains 30 runs, each with an id, start/finish time and up to 100 bounded
result entries. A start without a finish identifies an interrupted run. Log
writes precede cleanup; failure to persist the audit prevents new deletion.

### Storage settings and local API

Mac Settings → Storage shows category/project allocated totals, largest managed
variants with task age/status, aged artifact/experiment candidates and recent
runs. Categories include unmanaged worktrees, bot homes and other data under
Other. Cache/content subtotals are parts of Variants, not additional disk use.
APFS shared extents mean allocated totals are estimates, not physical recovery.

All destructive UI actions require explicit confirmation. Dirty/running tasks
can only be opened. Cache clearing and reclaiming are available individually for
eligible clean rows, and Clean up now runs the scheduled policy. Restoring a
reclaimed task continues to use the existing branch/recipe path.

Local endpoints: `GET /api/storage`, `GET/PATCH /api/storage/preferences`,
`POST /api/storage/cleanup` (`confirmed: true`), and `POST /api/storage/variant`
(`workspace_id`, `thread_id`, `action: clear_caches|reclaim`, `confirmed: true`).
`GET /api/health` adds nullable `free_bytes`, measured by statvfs without a disk
inventory; bots can check it cheaply. These are local daemon APIs, not new relay,
pairing or device operations.

### Safety checks shared with scripts/worktree-gc.mjs

1. The checkout must still be attached to its recorded variant branch. A
   different branch or detached HEAD is retained; no hidden recovery refs are
   introduced. The script also refuses detached worktrees and mismatched owner
   branches.
2. Tracked and untracked changes block. Ignored and untracked env copies pass
   only when byte-identical to the project's originals.
3. Present files with lowercase or `S` tags from `git ls-files -v` block, covering
   assume-unchanged and manual skip-worktree edits. Sparse's absent skipped
   files remain safe. Rebase, merge, cherry-pick, revert, bisect, and sequencer
   state all block removal.
4. Every commit must be reachable from live origin branches or patch-equivalent
   on the default/same-named branch. Remote failures retain the checkout.
   Verification borrows Git objects into temporary storage without updating
   refs, FETCH_HEAD, the inspected index, or Git configuration.
5. Ignored files must be regenerable. Root `vendor`, `target`, and `dist`, plus
   `frontend/dist`, are anchored: `reports/dist/q3-final-analysis.md` is work,
   not build output. `node_modules`, `.next`, `.phpunit.cache`, `.react-router`,
   `__pycache__` and `.pytest_cache` remain recognized cache directories.
   `bootstrap/cache`, `storage/framework/cache` and `storage/framework/views`
   are anchored at the root. Collapsed ignored parents are inspected, so
   sessions, logs, uploads, and unknown files still block removal.
6. One full `lsof -nP -Fpn` inventory checks accessible cwd **and open file**
   paths; `tail -f` from `/` still protects its input inside the checkout.
   No recursive lsof scan or broad home-directory scan is used. A failed
   inventory blocks cleanup. A zero exit **does not prove all processes were
   visible**: permissions can hide another user's descriptors. This daemon
   does not elevate privileges to inspect them.
7. Running Docker bind mounts are checked when a known local socket is
   available (DOCKER_HOST unix socket or /var/run/docker.sock). An unavailable
   inventory in that case blocks removal. Remote/custom contexts without that
   local socket signal, other container runtimes, and hidden descriptors remain
   blind spots; do not infer a global inactivity guarantee from these checks.
8. Under the thread gate, repeat local state, HEAD/branch, operation/index flags,
   process checks, and thread eligibility immediately before removal. Use
   `git worktree remove` without force and retain branches. The script rereads
   owner state at this boundary too. An unrelated external writer can still
   race a filesystem check; Git performs its own final cleanliness check.

The script additionally defaults to three days of age and skips open owners
unless `--include-open-threads` is explicit. Default operation is dry-run:

```sh
node scripts/worktree-gc.mjs --format markdown
node scripts/worktree-gc.mjs --apply  # human decision, never run automatically
```

The optional generated preset remains a broader manual policy, not the daemon's
allowlist. Apply rechecks safety and records an audit log under
`~/.falcondeck/worktree-gc/`.

Archiving does try to free folders. Running daemon logs on 5 Nov confirmed
Quizgecko removals at 14:17Z and 15:17Z. A read-only inspection found 43 archived
Quizgecko variant threads: five retained folders and 38 absent paths. Absence
alone does not establish whether archival or another cleanup removed a folder.

## Storage measurements and warning

The earlier **5.10 GiB** baseline forced a physical copy of a **3.03 GiB** warm
main-checkout node_modules. It is not representative of real variants and must
not be used to claim marginal dependency savings. The observed **0.49 GiB** new
sparse/cloned checkout was also a single volume-wide reading on an active Mac.
The ignored physical-copy measurement test is a synthetic diagnostic, not a
benchmark of the normal pnpm import path; it was not rerun for this correction.

The independent real-variant inventory reports median **1.09 GiB**, p75
**2.04 GiB**, p95 **2.21 GiB**. The firm expected benefit is about **0.6 GiB** of
omitted tracked content per new sparse checkout; logical `du` estimates can show
up to about **1.7 GiB** across the combined levers. These are not equivalent to
physical allocation savings. Existing pnpm installs may already use APFS
cloning. The installed receipt identifies pnpm 11.20.0 and an isolated linker
but does not record extent sharing/import method, so marginal dependency
savings remain unverified. No further heavy Quizgecko measurement was performed.
Use available bytes/statvfs for physical changes; du counts cloned extents in
full.

Before isolated creation/admission and every five minutes, measure free space
on the daemon data volume. Below **30 GiB**, Mac shows a toast with a “Free up
space” action opening Storage. At **15 GiB or above** the persistent critical
banner clears; below **15 GiB** the banner stays and the Mac attempts at most
one system notification per local calendar day, with a persisted daily claim.
The daemon's notification centre deduplicates critical notices per UTC day;
StoragePressure owns native Mac delivery to avoid double alerts. Storage warnings
have their own off switch. At 30 GiB or above the low crossing rearms. Unknown
measurements do not invent a zero-byte reading or clear the last known banner.

### Inventory reliability

Docker bind-mount inventory uses the daemon's desktop login-shell environment.
The standalone GC tool includes `/usr/local/bin` and `/opt/homebrew/bin` in its
Docker search path. Both inspect running container IDs separately: an ID that
vanishes with `No such object` is skipped; other inventory failures still keep
the checkout. GC dry runs validate the same restore recipe as apply. JSON
reports omit internal index/status snapshots, which remain in memory for final
removal checks.

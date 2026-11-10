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
A variant with a saved full recipe stays full if project defaults subsequently
change. A clean legacy variant without a saved recipe adopts the project sparse
default on its next restore. Dirty snapshots preserve the original selection and
materialized changes. External
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
hold the same per-thread gate as final reclamation. Thread eligibility and local
safety are checked again after acquiring it. Local branches pin unpublished
commits; reclamation does not need network reachability.

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

Reclamation keeps the thread, branch, native history and sparse recipe. It first
moves the checkout into a **recoverable quarantine**, not permanent deletion.
The local branch pins committed work even when it has never been pushed.

| Event | Behaviour |
|---|---|
| Archive (single/all) | Attempt safe quarantine in the background. |
| Successful live turn completion | Update task activity; clean checkouts become candidates after more than 24 idle hours. |
| Periodic maintenance | Check each managed filesystem every five minutes; run daily cleanup at most once per 24 hours. |
| Resume/unarchive or checkout access | Cancel intact quarantine or restore from the kept checkpoint/branch/recipe. |
| Delete thread/workspace | Return without waiting; safe reclamation runs in the background. |
| Daemon startup | Recover persisted receipts and apply current safety checks. |

### Daily daemon policy

The daemon owns this zero-token background job. A durable
`storage-last-scheduled.json` marker is independent of manual/archive runs;
restart does not replay a daily run already started. `storage-preferences.json`
contains off switches for scheduling, caches, clean-checkout reclamation and
warnings. Artifact/experiment deletion is no longer supported. Legacy preference
keys for it are accepted for compatibility, ignored, and omitted when saved.
“Clean up now” explicitly confirms the same policy. Invalid settings fail closed.

- Main project checkouts, clones, shared/changed ownership, detached or changed
  branches, symlink roots and symlink ancestors are retained.
- Running, waiting, queued, dispatching and dependency-preparation tasks are
  protected. Accessible processes with cwd/open files inside a checkout block
  cleanup. Task activity and non-cache checkout activity must be over 24 hours old.
- **Clean** checkouts can be reclaimed after more than **24 idle hours**, or
  archival, with no tracked/untracked edits, hidden present index flags or Git
  operation in progress. Recursive checkout and worktree HEAD/index/reflog
  activity must also be over 24 hours old. Unpublished commits are safe on the
  kept branch; no fetch or remote publication is required.
- Cache cleanup can apply to clean or dirty variants after **three idle days**.
  Its 24-hour recency test uses tracked/non-ignored files and thread activity,
  rather than mtimes inside the cache. Sparse omissions are not deletions;
  genuinely deleted tracked paths use their nearest surviving parent for activity.
- An ignored name alone never grants deletion authority. The exact cache
  locations are `node_modules`, `frontend/node_modules`, `target` and
  `frontend/target`. Node package files need a matching content digest, size and
  mode in a supported pnpm store receipt, including recorded build side effects.
  Installer metadata, shims, links, missing receipts, edited files and additions
  remain recoverable. Timestamps alone never prove a file disposable. Receipt,
  manifest and package reads are bounded and reject symlinks/special files with
  nonblocking, no-follow opens. Rust caches
  require Cargo input, a rustc receipt, CACHEDIR.TAG and positively recognised
  compiler artifacts. Unknown descendants, nested Git state, databases, private
  configuration and special files are retained. Generic `build`, `.cache`, `dist`
  and `vendor` paths are not disposable merely by name.
- A local-only project hook can restrict the supported exact cache list:
  `git config --local falcondeck.storageCaches '["frontend/node_modules"]'`.
  Nonempty lists select those supported locations; an absent/empty list uses
  defaults. Relative paths cannot contain `.`, `..` or `.git`; configuration
  cannot make an unsupported directory safe. No project script is executed.
- Each cache must additionally be ignored, contain no tracked descendants and
  pass containment/identity/process checks. The **same content proof** protects
  ignored data during checkout reclamation, including manual dirty snapshots.
  A unique ignored file no longer blocks an entire checkout: retain that file
  privately and reclaim only Git-recoverable or positively proved cache bytes.
  Inventory cache totals include unverified candidates; mutation proves each
  file afresh. A partial dependency cache needs reinstalling before use.
- Artifacts/experiments older than 30 days are **candidates only**, never
  automatically deleted. Native Codex stores and logs remain report-only.
  No repository GC apply script is invoked.

Scans/hashing use dedicated background-QoS threads on macOS. Git operations run
at nice 10. Audit writes precede mutation. The small log retains 30 runs, each
with start/finish times and up to 100 bounded result entries; an unfinished run
is explicit. Old 72-hour completion markers remain state-compatible but do not
control the production timer.

### Quarantine and partial-failure recovery

Before mutation, persist a receipt in the project's shared Git directory at
`falcondeck-variants/<slug>.quarantine.<uuid>.json`. The receipt records original
and quarantine paths, filesystem identity, a full byte fingerprint, recovery
checkpoint and transaction phase. Metadata files and containing directories are
synced before dependent mutations. A small project pointer beside the checkouts
keeps quarantine discovery and volume warnings alive after workspace deletion.
It retains resolved Git metadata paths; health also resolves bounded `.git` and
`commondir` pointers for projects using separate Git directories or linked checkouts.
Checkout snapshots also pin their original
index. Atomically rename into a private sibling
`.storage-quarantine-<slug>-<uuid>` on the same filesystem, repair the Git worktree
registration, and reverify. Cross-device rename refuses without a copy/delete
fallback. Failed verification restores the original name when possible; if a
writer recreated it, both paths are retained for recovery.

A quarantine lasts **at least 24 hours**. A subsequent enabled daily/manual run
rechecks bytes, index, ignored-content proof, identity and processes before purge.
Late writes retain the directory. The task admission gate remains held. Starting
another task cannot authorize deletion of a running/queued variant. Disabling the
relevant cache/reclamation switch also retains its pending quarantines.

Before purge, unique ignored data is cloned into a mode-0700 sibling vault on
that volume, outside Git. A mode-0600 private manifest records paths and content
fingerprints; shared Git metadata records only the vault pointer. File ownership,
permissions, ACLs and extended attributes are copied without running project
code. Linux copies explicitly preserve extended attributes; reconstructed
ancestor access/default ACLs and other attributes are copied and verified.
Private payload fingerprints include extended attributes. Cache proof also
retains unverified attributes and ACLs, including on package directories; only
macOS-generated provenance metadata is treated as regenerable. Copy and sync failures retain the original quarantine. If a live compiler manifest
disappears, the cache contents and root permissions are retained privately
rather than losing the bytes or leaving an unpurgeable quarantine. Content and metadata
are verified before the manifest is marked complete and removal can proceed.
Vault directories are created with mode 0700 atomically. ACL hardening also
runs on every reopen, including interrupted creation. Payload entries are copied
and synced in private vault temporaries before atomic publication; incomplete
older copies are retained separately and retried from the verified source.
Snapshot verification rejects newly appeared non-ignored files before Git add,
so verification does not store their unexpected contents in Git.
Private copy temporaries never live in a Git checkout. Ignored non-directory
files and links at cache-named paths are preserved as ordinary private entries.
Private filenames are passed to Git as literal paths during restoration. After
the verified overlay (including ignore rules that are themselves ignored), Git
must report no untracked non-ignored files under the private roots. Otherwise
the unpublished stage is refused and the vault retained. No snapshot/Git add
runs between that overlay and privacy validation. When a
new sparse default omits an original tracked ancestor `.gitignore`, that file
is materialized too; intentional tracked deletions are left intact.
Private vaults are never automatically purged and remain visible in Storage.
Restore overlays verified private files into a fresh staging checkout before
publication, refusing tracked-file or destination conflicts and keeping backups.
Sparse restoration retains private files outside the recipe too. Cache-only
cleanup syncs unverified files in a private staging directory, records its
identity, then publishes the complete cache with an exclusive atomic rename.
A later purge never replays old copies over subsequent edits or deletions.
Interrupted staging copies are retained privately and rebuilt from the verified
backup. A published directory's durable identity lets recovery complete after an
interrupted ready-flag write without overwriting newer edits. Writer-created
conflicts retain both copies and block admission. Legacy completed quarantines
without a preservation flag do not block an existing, reinstalled checkout;
their unverified contents are still privately retained before purge.

Purge writes a `purging` phase before removal. Failure/interruption is reported
as **RecoveryRequired**, never as an intact **Kept** checkout. Restore does not
accept a surviving tracked file as proof of completeness when a snapshot is
pending. It preserves partial residue at a separate recovery path, then
reconstructs the saved working tree and index before admitting the task.
Retained residue must reconnect its existing Git index before replacement;
relative registrations and interrupted/missing `.git` links are reconciled. Original
residue is never silently overwritten. An intact quarantine can be renamed back;
clean legacy checkouts adopting sparse defaults are recreated with that recipe.
The first run releases **no physical space immediately**: bytes remain in
quarantine until a later eligible purge. Snapshot objects also consume space.

External writers do not participate in daemon locks. Atomic rename removes the
original pathname, a full grace period permits in-flight writers to settle, and
late changes/processes prevent purge. This is recoverable quarantine rather than
an assertion that filesystem/process checks provide a global write lock.

### Manual snapshots and Storage

Mac Settings → Storage shows categories/projects, largest variants, per-volume
availability, quarantine sizes/phases/earliest purge, candidate artifacts and
recent runs. APFS shared extents can be counted repeatedly by allocated-size
measurements; estimates are not promises of physical recovery.

Dirty variants idle over **seven days** have checkboxes and a manual-only action.
A one-click eligible action displays count and size and still asks for explicit
confirmation. Tracked deletions limited to `public/vendor` and
`resources/views/vendor` appear in their own dirty group. They are never treated
as clean or automatically reclaimed. Running tasks can only be opened. Safe cache
cleanup is available separately; clean rows offer reclamation.

Snapshot creation uses an alternate index and does not move the branch or modify
the real index. The snapshot commit pins HEAD, prior snapshots and a separate
**original index tree** commit. Thus staged version A and working version B both
remain reachable and restore independently. It includes tracked/untracked
non-ignored files, deletions, renames and binaries. Ignored unique/private data
is never silently discarded. Lossy filters, submodules, newly discovered
untracked nested repositories and unsupported paths
are refused. Restore verifies the working tree and saved index before publishing;
sparse omissions and outside-recipe additions are retained. Failed verification
removes nothing from the original checkout.

Local APIs: `GET /api/storage`, `GET/PATCH /api/storage/preferences`,
`POST /api/storage/cleanup`, `POST /api/storage/variant`, and confirmed
`POST /api/storage/snapshots` (1–100 explicit targets per request; the desktop
batches larger confirmed selections and retains completed batch results). `GET /api/health` returns
legacy nullable `free_bytes` for the data volume and a `volumes` list with device
identity, representative path and nullable free bytes. Health uses stat calls,
not checkout scans or Git subprocesses. Bounded project-pointer reads retain
volume discovery after workspace deletion. Per-volume warnings and Storage use
the same attribution.
No relay, pairing or device operation is added.

### Standalone GC tool

`scripts/worktree-gc.mjs` remains a separate legacy manual policy. It still
requires remote publication and uses its own cache presets/age rules; do not
infer the daemon's new quarantine and cache-content guarantees from its output.
The daemon never calls its apply mode. This branch does not change Quizgecko
scripts or run any GC apply command.

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
on each filesystem containing daemon data or a retained variant. Checks deduplicate
by filesystem identity and attribute the representative path. Below **30 GiB**,
Mac shows a toast with a “Free up
space” action opening Storage. At **15 GiB or above** the persistent critical
banner clears; below **15 GiB** the banner stays and the Mac attempts at most
one system notification per local calendar day, with a persisted daily claim.
The daemon's notification centre deduplicates critical notices per volume/UTC day;
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

### External volumes

Free-space reporting is per filesystem, including variants mounted under a
separate drive. The creation root is still fixed at `$HOME/.falcondeck/variants`;
this branch adds no relocation setting and retains symlink roots for review.
Snapshots and their index/metadata live in the project's shared Git directory,
which can remain on the startup volume. An external checkout does not move
Codex databases or guarantee startup-volume headroom. Dependency clonefile across
filesystems falls back to a cold install notice. Future relocation also needs
explicit unavailable-drive/mount identity handling rather than treating an
unplugged path as an ordinary reclaimed checkout.

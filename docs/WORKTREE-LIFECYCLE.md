# Worktree lifecycle and disk hygiene

An isolated thread owns a Git worktree and branch under
`~/.falcondeck/variants/<project>/<slug>/`. History belongs to the native agent;
removing the checkout never deletes the thread or branch.

## Provisioning

Projects use full checkouts with no dependencies copied by default. Opt in with
an external JSON file and a repository-local Git setting:

```sh
git config --local falcondeck.worktreeSetup /absolute/path/to/worktree-setup.json
```

Example for a large pnpm project:

```json
{
  "sparse_exclude": [
    "data/qbank", "docs/research", "docs/marketing", "docs/help-center"
  ],
  "dependency_roots": ["frontend"],
  "sparse_hint": "QBank and Curriculum services import data/qbank. Before working on those services, run git sparse-checkout add data/qbank."
}
```

This is per repository, shared by its worktrees, and contains no project-specific
paths in the daemon's production policy. The file can live outside the project
(e.g. in `~/.falcondeck/`). No configuration means no sparse checkout or warm
install. Paths must be relative directories; `"."` is allowed for a dependency
root. Configuration errors fail creation visibly.

Creation and restore both use `git worktree add --no-checkout`, configure
cone-mode sparse checkout, check out HEAD, then provision dependencies and the
small env-file allowlist (`.env*`, `.envrc`, `*.local.*`). Sparse selection includes
all other tracked directories and ancestor files. The example keeps
`docs/reports` and `docs/development`, including gate receipts. Git enables
`extensions.worktreeConfig` and stores sparse settings in the new worktree's
config. Integration tests verify the main checkout and an existing full variant
retain their files and clean status, and merging main from a sparse worktree
works even when the merge changes excluded files.

Every dispatched turn in a configured sparse variant receives a context hint
explaining missing directories and how to restore them:

```sh
git sparse-checkout add data/qbank  # add one directory in this worktree
git sparse-checkout disable        # materialize the full tree
```

Restoration reapplies the current project configuration, so a per-worktree
manual addition needs to be repeated after reclamation.

### Warm dependencies

For each configured dependency root, FalconDeck tries the project folder's warm
`node_modules`. It requires byte-identical package manifests, lockfiles, npm
configuration and workspace descriptors in the project and new checkout, plus
a pnpm installed-lock receipt (`node_modules/.pnpm/lock.yaml`) identical to the
source lockfile. Missing/mismatched/stale receipts cause a cold fallback. npm and
yarn installs currently use that fallback because they do not supply the pnpm
receipt this implementation verifies. No package manager or lifecycle script is
run automatically; the agent uses the project's normal install when cold.

On macOS files use APFS `clonefile`; on other platforms `cp --reflink=always`
is attempted. Failure (including unsupported/cross-volume clones) removes the
partial staging directory and leaves dependencies absent, never a full-copy
fallback. Relative symlinks must stay within node_modules; absolute or escaping
links reject the warm tree. Textual source paths in generated pnpm bin shims
are relocated to the destination. Binary files containing source paths reject
the warm tree. Source inputs and the cloned receipt are checked again before
publishing the staged directory. The source is read only. Clone contents can
subsequently diverge without modifying the source.

Use filesystem available bytes (`statvfs` or `df`), not `du`, to measure savings:
`du` counts APFS clones in full. The ignored Rust test
`variant::setup::measurement::measure_fresh_variant` measures a full checkout
with physically copied dependencies versus a sparse checkout with cloned deps,
in a throwaway shared clone. Set `FALCONDECK_MEASURE_PROJECT` to the source
repository and run it with `--ignored --nocapture`. It never changes the source
repository or real variant registrations.

## Reclamation

| Event | Behaviour |
|---|---|
| Archive (single or all) | Try safe reclamation in the background; log retained reasons. |
| Successful turn completion | Schedule one attempt after **72 hours** without further thread activity. |
| Unarchive, send/resume turn, start review | Restore a missing checkout from its kept branch before provider startup. |
| Delete thread | Try the same safe reclamation; retain unsafe checkouts and log reasons. Legacy clones are kept for manual review, with committed branches preserved in the project when possible. |
| Daemon startup | No backlog sweep and no restored cleanup timers. |

A successful turn alone does not establish that work is finished. The 72-hour
grace avoids churn during short pauses. At the deadline the completion timestamp
must still match; the thread must be idle, unpinned, with no queued or dispatching
request. A later turn or update cancels eligibility. Dirty or unpushed work is
always retained. Timers are intentionally ephemeral: a daemon restart cancels
them; a subsequent successful turn can schedule a new attempt. Nothing inventories
or sweeps the existing backlog. The first removal run over it remains a human
decision after reading a dry-run report.

Admission, unarchive and reclamation use a per-thread gate so a resumed turn
cannot race cleanup. Restoration failures stop turn dispatch instead of sending
the provider a missing working directory. Checkout removal retains variant
metadata and all native thread history.

### Safety rules (daemon and script)

`variant/reclaim.rs` and `scripts/worktree-gc.mjs` implement the same file/remote
rules; change them together:

1. Tracked and untracked work must be clean. Both ignored and untracked env
   files pass only when byte-identical to the project's copy.
2. Every commit must be reachable from a live `origin` branch or patch-equivalent
   on the remote default/same-named branch. Unreachable remotes block removal.
   `ls-remote` plus scratch object storage verify this without changing refs,
   FETCH_HEAD, config or the inspected index.
3. Ignored files must be regenerable: `node_modules`, `vendor`, `target`, `.next`,
   `dist`, `.phpunit.cache`, `.react-router`, `__pycache__`, `.pytest_cache`,
   `bootstrap/cache`, `storage/framework/cache`, `storage/framework/views`.
   Collapsed ignored ancestors are inspected so **sessions, logs, uploads, and
   other unknown files still block removal**. This closes the earlier cache
   allowlist gap without treating all Laravel storage as disposable.
4. No process may have its cwd in the checkout or a descendant. `lsof -d cwd`
   checks this explicitly; a failed/incomplete inventory blocks cleanup.
   Canonical paths account for macOS `/var` and `/private/var` aliases.
5. Local status, HEAD and processes are checked again after remote verification,
   immediately before `git worktree remove` without `--force`. Branches survive.
   As with any filesystem inspection, an unrelated external process can still
   change state after the final check; Git performs its own cleanliness check.

The script also requires three days of age and skips open owner threads unless
`--include-open-threads` is explicitly given. It defaults to a dry run:

```sh
node scripts/worktree-gc.mjs --format markdown
node scripts/worktree-gc.mjs --apply  # human decision; never run automatically
```

The optional `--rebuildable-preset generated` remains a broader manual preview;
its additional paths are not the daemon's automatic policy. Apply rechecks
safety and writes an audit log under `~/.falcondeck/worktree-gc/`.

Archiving **does** try to free the folder; it is not an unconditional removal.
On 5 Nov 2026, the running daemon logged Quizgecko archive removals at 14:17Z and
15:17Z, and earlier retained entries explicitly named framework caches and
unpushed commits. A read-only state/filesystem check during this work found 43
archived Quizgecko variant threads: 5 retained checkouts and 38 absent paths.
No existing variants were removed or changed for this investigation.

## Disk warning

Before creating an isolated checkout and when admitting a turn, check actual
available space on the FalconDeck data volume. Below 25 GiB, show one persistent
operational warning in the clients' service/operational notices. Repeated low
checks do not emit more warnings. A check at or above 25 GiB clears it and rearms
it for the next crossing. The latch lasts for the daemon session; after restart
a still-low disk gets one current warning again. There are no periodic scans or
push notifications for these checks.

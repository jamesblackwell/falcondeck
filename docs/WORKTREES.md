# Worktrees & workspace isolation — product design

Status: isolation shipped; merge-back remains proposed. Updated 2026-11-01.

## Where we stand

A FalconDeck workspace is a folder. Threads run in that folder by default, on
whatever branch happens to be checked out, while the composer can start a
thread in an isolated worktree. Keeping the project folder as the default is a
deliberate strength: it matches how people iterate against an existing dev
server and editor session.

It breaks down in exactly two situations:

1. **Parallelism** — two threads mutating one checkout stomp each other.
2. **Risk isolation** — you want an agent to try something big without
   touching the checkout your dev server / editor is sitting on.

Isolation is a tool for those two situations, not a religion. The design
goal is: *same-folder stays the default; isolation is one click when you
want it; and it inherits everything we already built (diff panel, review,
remote hosts) instead of growing a parallel universe.*

## What the field does

| Tool | Unit of isolation | Mechanism | Env files / deps | Merge-back |
|---|---|---|---|---|
| **Conductor** | Workspace ≙ one branch (1:1, "a branch can only be checked out in one workspace at a time") | git worktrees | setup script per repo, `CONDUCTOR_PORT` per workspace | review diff → PR → merge → archive workspace |
| **Polyscope** | Throwaway workspace per task ("create → work → merge → delete") | **CoW clone** (APFS clonefile on macOS; `git clone --local` elsewhere) | macOS: clone carries *everything* incl. `node_modules` and `.env`; Linux/Windows: gitignored files lost → `setup` script (`npm ci`), `copyGitignored` override | merge or PR, then delete |
| **ChatGPT app** | Per-project "Create permanent worktree" action | git worktree | (opaque) | manual |
| **bb** | "Environment" = workspace×host binding, shareable across threads, managed lifecycle | worktrees under the hood | env provisioning per environment | thread-level |
| **Claude Code** | Per-agent `isolation: worktree` flag | git worktree, auto-removed if unchanged | none (worktree semantics) | left to the agent |

Two philosophies recur: **worktree** (Conductor/ChatGPT — branch-centric,
shared object store, but no gitignored state) and **clone** (Polyscope — carries
the entire working state including dependencies). APFS cloning shares file
contents, but it still creates and later deletes an entry for every ignored
cache file. Real repositories with large Rust and Xcode caches made that
metadata cost unacceptable, so FalconDeck uses worktrees and copies only its
small environment-file allowlist.

## Product model

### 1. The unit: an isolated thread, not a second project tree

Isolation is a property of a **thread** (and of the checkout backing it),
not a new top-level object. In the composer, next to model/mode selectors:

```
Run in: ◉ Project folder   ○ Isolated copy
```

- Default per project ("New threads: project folder | isolated"), one-click
  override per thread. Same-folder remains the global default.
- Starting an isolated thread makes the daemon create a **variant**: a
  checkout under `~/.falcondeck/variants/<project>/<slug>/` on whatever
  machine owns the workspace (works identically on remote hosts — the
  daemon does it, so servers get isolation for free).
- The thread's cwd, git status, and diff panel all point at the variant.
  Sidebar shows a small branch chip on isolated threads.
- Multiple threads *can* share one variant (bb's "environment" idea) via
  "New thread in this copy" on an isolated thread — but that's a follow-up,
  not v1.

### 2. The mechanism: lean worktrees

The daemon uses `git worktree add` and copies a small allowlist of untracked
environment files (`.env*`, `.envrc`, `*.local.*`). It deliberately does not
copy ignored dependencies or build outputs into the isolated checkout; instead
it shares dependencies from the project folder (below).

The original APFS copy-on-write implementation avoided copying file contents,
but still replicated every filesystem entry. Repositories with large Cargo,
Xcode, or dependency caches could take minutes to create and could make disk
usage difficult to understand. Worktrees keep creation proportional to tracked
source instead of ignored build state.

#### Dependencies are shared, not installed per variant

A bare worktree has no `node_modules`, and agents used to run their own
install in every variant (Quizgecko: `frontend` ~1 GB plus `mobile-expo`
~1.8 GB, on top of ~1 GB of tracked source, so 2–5 GB each; 91 GB across 55
variants on 30 Oct 2026). After creating a variant, and again when an archived
thread's checkout is restored, the daemon prepares dependencies
(`crates/falcondeck-daemon/src/variant/setup.rs`):

1. **Project script.** If the checkout contains `.falcondeck/setup-worktree.sh`,
   else `.codex/scripts/setup-worktree.sh`, the daemon runs it with `bash`, cwd
   the variant, 120 s limit. The script owns dependency handling. Its
   environment:

   | Variable | Value |
   |---|---|
   | `FALCONDECK_PROJECT_PATH` | the project folder (source of shared files) |
   | `FALCONDECK_VARIANT_PATH` | the variant checkout (also cwd) |
   | `FALCONDECK_VARIANT_SLUG` | the variant slug (branch is `falcondeck/<slug>`) |
   | `CODEX_ROOT_PATH`, `CODEX_WORKTREE_PATH` | same two paths, for the Codex script |

   The script comes from the variant's own tree, so it must be committed. A
   non-zero exit, a spawn failure or a timeout is logged and falls through to
   step 2. `.cursor/worktrees.json` is deliberately not honoured: Cursor's
   script runs `composer install` and `npm install` when dependencies are
   missing, which is the cost this removes. A repo that wants Cursor's behaviour
   can call it from `.falcondeck/setup-worktree.sh`.
2. **Built-in linking.** With no script, or a failed one, the daemon symlinks
   `<dir>/node_modules` from the project folder for every tracked
   `package.json` directory, only when all of these hold:
   - the project folder has that `node_modules` and the variant does not;
   - `package.json` and every lockfile (`package-lock.json`,
     `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock`,
     `bun.lockb`) are byte-identical in both trees, so an uncommitted upgrade in
     the project folder, or a branch that changed dependencies, installs its
     own;
   - the package is not a workspace root (`"workspaces"` in `package.json`, or
     members listed under `packages:` in `pnpm-workspace.yaml`; a pnpm file that
     is settings-only or lists just `.` is a single package), nor beneath one,
     because an install at the root manages the packages beneath it;
   - no top-level entry (or `@scope/*` entry) of `node_modules` is a symlink
     leaving it. Workspace packages and `file:` dependencies are links into the
     project's source, which would make the variant import the project folder's
     code. pnpm's internal `.pnpm` links are fine.

   Quizgecko's `frontend` and `mobile-expo` qualify; FalconDeck's own repo (an
   npm workspace) does not and keeps its per-variant install.

`vendor` is never linked. Composer's generated autoloader resolves app code
relative to `vendor/`'s real path, so a symlinked `vendor` would load the
project folder's classes and run tests against the wrong code. `target` and
other build outputs are never shared either.

Linked paths are appended as anchored entries (`/frontend/node_modules`) to the
project repository's `.git/info/exclude`. A `.gitignore` line written
`node_modules/` matches directories only, so without this the link would show
as untracked, be swept up by `git add -A` and block reclaim. The file is
shared by all worktrees (git has no per-worktree exclude), and the entries are
inert in the project folder, where those paths are already ignored.

**Behaviour to know about**

- Edits to the project folder's `node_modules` show up in every linked variant.
- A task that must change dependencies or a lockfile needs its own install.
  `rm <dir>/node_modules` (this removes only the link) and install normally.
  `npm install` and `npm ci` already replace the link; **pnpm writes through
  it into the project folder**, so remove the link first. Agents are told this
  in the injected FalconDeck instructions (`agent_context.rs`).
- Deleting or reclaiming a variant removes the link, never its target (git and
  `remove_dir_all` do not follow symlinks; covered by tests).
- Dev servers resolve the link to the project folder's real path. Vite's
  `server.fs.allow` and tools that cache under `node_modules/.vite` or
  `node_modules/.cache` share state between variants and the project folder.
  Quizgecko's Codex worktrees already run this way.
- Quizgecko's Codex script also runs `scripts/dev-env.sh --write-env`, giving
  each variant its own ports and database names in its `.env`. Run `make dev`
  in the variant before browser or backend tests, as the script prints.

To opt a repo in without Codex tooling, commit a `.falcondeck/setup-worktree.sh`
that links or copies what it needs, for example:

```sh
#!/usr/bin/env bash
set -euo pipefail
ln -s "$FALCONDECK_PROJECT_PATH/frontend/node_modules" frontend/node_modules
```

Planned: a `cleanup` hook before deletion, and a `FALCONDECK_VARIANT` port
hint for scripts that start servers.

### 3. Merge-back: one split button in the session header

The control lives in the session header's trailing group, before New — not
in the diff panel, which keeps one obvious place to land work. It is hidden
unless the thread has a variant; same-folder threads have no branch of their
own to land.

```
[⑃ Merge ▾]   Create pull request · Draft pull request · Merge and push
```

- **Create pull request** is the default click, *not* merge. FalconDeck's
  project folder is usually dirty, so a primary "merge now" would stomp
  live work. Commits leftover variant changes if needed, pushes the branch,
  then `gh pr create` into the recorded base branch.
- **Draft pull request** = the same, with `--draft`.
- **Merge and push** = commit (if dirty) → merge into the base branch in
  the project folder → push. It **refuses when the project folder has
  uncommitted changes**, or when that folder is not on the base branch; the
  menu disables it up front and says why. On conflict, tell the agent to
  resolve — it's already sitting in the variant with full context.
- `gh` is required for the PR modes and reported clearly when missing.
  Merge mode does not need it.
- The variant and its branch always survive a ship. Nothing is force-pushed.
- Archiving the thread offers variant cleanup; a merged, clean variant is
  deleted silently (Claude Code's "auto-removed if unchanged" rule,
  extended to "removed if merged").
- ChatGPT's "permanent worktree" becomes: a variant you've pinned from the
  thread menu ("Keep this copy") — it survives thread archival and shows
  under the project in the sidebar.

### 4. What we deliberately do NOT build

- **Worktree-by-default.** The user is right that it's often worse: you
  lose live dev servers, editor context, and the "it's just my folder"
  mental model. Defaults stay same-folder.
- **A second sidebar hierarchy** of workspaces×branches (Conductor's
  model). Threads stay the unit users think in; variants are plumbing that
  surfaces as chips and a diff-panel header.
- **Branch-exclusivity bookkeeping** (Conductor's "one workspace per
  branch"). Slugged branch names (`falcondeck/<thread-slug>`) sidestep it.

## Implementation status

- `falcondeck-core`: isolation choice and `ThreadVariant` metadata are shipped,
  including `base_branch`, recorded from the project `HEAD` when the checkout is
  created. Variants made before that field falls back to `main`, then `master`.
- Daemon: worktree creation, env-file allowlist copying, provider cwd override,
  and checkout deletion are shipped.
- Daemon: `git.commit` and `thread.ship` (pr / draft_pr / merge) are shipped on
  the local HTTP API and the relay bridge, so remote web ships the same button.
- Desktop/remote-web/mobile: isolation selection and thread indicators are
  shipped. Desktop and remote web both mount the shared Merge split button;
  mobile stays read-only on shipping.
- Daemon: dependency sharing (project setup script, else guarded
  `node_modules` symlinks) is shipped; see "Dependencies are shared".
- Cleanup scripts, configurable allowlists, and pinned copies remain
  follow-up work.
- Remote hosts require no extra plumbing because the daemon creates their
  worktrees locally; the `.env` allowlist matters most on those hosts.

Remaining order: allowlist UI → pinned variants.

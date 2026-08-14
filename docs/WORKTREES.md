# Worktrees & workspace isolation — product design

Status: isolation shipped; merge-back remains proposed. Updated 2026-08-14.

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
carry ignored dependencies or build outputs into the isolated checkout.

The original APFS copy-on-write implementation avoided copying file contents,
but still replicated every filesystem entry. Repositories with large Cargo,
Xcode, or dependency caches could take minutes to create and could make disk
usage difficult to understand. Worktrees keep creation proportional to tracked
source instead of ignored build state.

Planned setup/teardown scripts will live in project settings (stored
daemon-side, like goals): `setup` after variant creation (`npm ci`, migrations)
and `cleanup` before deletion. A future `FALCONDECK_VARIANT=<slug>` environment
variable will let scripts choose ports.

### 3. Merge-back: extend the existing diff panel

The diff panel already shows working-tree changes per workspace. For a
variant it grows a header:

```
falcondeck/fix-login-flow · 4 files · +182 −40
[Commit…] [Merge into main] [Open PR] [Discard copy]
```

- **Merge into main** = commit (if dirty) → merge into the base branch of
  the project folder (fast-forward preferred; on conflict, tell the agent
  to resolve — it's already sitting in the variant with full context).
- **Open PR** = push branch + `gh pr create` (capability-gated on `gh`).
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

- `falcondeck-core`: isolation choice and `ThreadVariant` metadata are shipped.
- Daemon: worktree creation, env-file allowlist copying, provider cwd override,
  and checkout deletion are shipped.
- Desktop/remote-web/mobile: isolation selection and thread indicators are
  shipped.
- Merge, PR, setup/cleanup scripts, configurable allowlists, and pinned copies
  remain follow-up work.
- Remote hosts require no extra plumbing because the daemon creates their
  worktrees locally; the `.env` allowlist matters most on those hosts.

Remaining order: diff-panel merge actions → setup scripts + allowlist UI →
pinned variants.

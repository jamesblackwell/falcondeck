# Worktrees & workspace isolation — product design

Status: proposed design, 2026-08-07. Not scheduled; decide scope before building.

## Where we stand

A FalconDeck workspace is a folder. Every thread runs in that folder, on
whatever branch happens to be checked out. That is a deliberate strength —
the README calls it out ("same-folder workflows by default instead of
forcing a worktree model") and it matches how people actually iterate on a
dev server: run the agent where the dev server is already running, see the
change live, commit when happy.

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

Two philosophies: **worktree** (Conductor/ChatGPT — branch-centric, shared
object store, but gitignored state like `node_modules`/`.env` doesn't exist
in the new checkout) and **clone** (Polyscope — task-centric, and on APFS
the clone is instant, costs ~0 bytes until files diverge, and *carries the
entire working state including env files and installed deps*).

The Polyscope insight is the important one for us: **on macOS, CoW cloning
is strictly better than a worktree for agent isolation.** No setup script
needed for the common case, `.env`/`node_modules`/build caches all come
along, creation is instant, and disk cost is only the diff. Worktrees are
the fallback where CoW doesn't exist — which, notably, is most of our
remote hosts (ext4 has no reflink; XFS/btrfs do).

## Proposed model

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

### 2. The mechanism: CoW clone first, worktree fallback

Daemon picks per filesystem, user never chooses (an "Advanced" override
exists in project settings):

1. **APFS / reflink-capable** (`clonefile`/`cp --reflink`): CoW-clone the
   working tree — instant, carries env files and dependencies, no setup
   script needed. Then `git switch -c falcondeck/<slug>`.
2. **Otherwise** (typical Linux server): `git worktree add` + copy a small
   allowlist of untracked files (`.env*`, `.envrc`, `*.local.*` — visible,
   editable list in project settings) + run the project **setup script**
   if one is defined.

Setup/teardown scripts live in project settings (stored daemon-side, like
goals): `setup` (after variant creation; `npm ci`, migrations) and
`cleanup` (before deletion). Env var `FALCONDECK_VARIANT=<slug>` is set so
scripts can pick ports — Conductor's `CONDUCTOR_PORT` pattern
generalized.

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

## Implementation sketch (for sizing, not commitment)

- `falcondeck-core`: `ThreadVariant { slug, path, branch, mechanism, pinned }`
  on `ThreadSummary`; `StartThreadRequest.isolation: "shared" | "isolated"`.
- Daemon: `variant.rs` — create (clonefile via `std::fs` + `cp -c`
  fallback / `git worktree add`), env-file allowlist copy, setup script
  run, delete; thread cwd override in the provider spawn paths (codex/
  claude/ACP all take a cwd today); merge/PR/discard ops; register the new
  RPCs (remember the RpcRegister table).
- Desktop/remote-web: composer toggle, thread chip, diff-panel header
  actions, project-settings section (default mode, env allowlist, setup/
  cleanup scripts). Mobile: read-only chip first.
- Remote hosts: nothing extra — variants are daemon-side, so quizgecko-ops-2
  gets them the day the daemon ships them. (Server FS is ext4 → worktree
  path; its `.env` allowlist matters most there.)

Rough order: daemon variant lifecycle → composer toggle + chip → diff-panel
merge actions → setup scripts + allowlist UI → pinned variants.

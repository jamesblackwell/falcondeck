# Isolated-thread Merge / PR control

## Why

Isolated threads already create a folder plus a branch (`falcondeck/<slug>`). There is no product way to land that branch. Users fall back to reconstructing git. Polyscope solves this with one top-right control: **Merge ▾** → Merge and push / Create pull request / Draft pull request.

FalconDeck should get the same control, with one extra rule: do not write into a dirty project folder.

## Product

Show the control only when `thread.variant` is set. Same-folder threads stay out of this v1.

Place it in `SessionHeader`’s trailing `ToolbarGroup` (top right), **before** New / pairing / panel toggles. Desktop compact header and remote-web header both use this slot, so one shared control covers both.

Visual: accent split button, Git-merge icon, label **Merge**, chevron. Matches Polyscope; uses FalconDeck accent tokens, not a one-off blue.

| Action | What it does |
| --- | --- |
| **Create pull request** (default click) | Commit leftover variant changes if needed, push `falcondeck/<slug>`, `gh pr create` into the recorded base branch. |
| **Draft pull request** | Same, with `--draft`. |
| **Merge and push** | Commit if needed, merge the variant branch into the project’s base branch, push. Refuse if the project folder has uncommitted changes. |

Default click is **Create pull request**, not merge. FalconDeck’s project folder is often dirty (same-folder default). A primary “merge now” would stomp live work. The visible label can still be **Merge**; the menu makes the three destinations obvious.

After success: toast with the PR URL or the merge commit; open the URL when present. Do not delete the variant. Cleanup stays on thread archive, as `docs/WORKTREES.md` already says.

## Daemon contract

Git mutations belong in the daemon, in the variant checkout. Clients only invoke and render.

Add to `crates/falcondeck-core` + `packages/client-core`, then HTTP and relay RPC:

- `git.commit` — stage and commit in the thread checkout if dirty. Message defaults to the thread title.
- `thread.ship` (or `git.ship`) with `{ workspace_id, thread_id, mode: "pr" | "draft_pr" | "merge" }`.

`thread.ship` sequence:

1. Require `thread.variant`. Fail closed otherwise.
2. If the variant tree is dirty, commit all changes (`git add -A` scoped to that checkout) with the thread title.
3. Push `variant.branch` to `origin`.
4. **pr / draft_pr:** `gh pr create --base <base> --head <variant.branch>` (plus `--draft`). Return `{ url, mode, branch, base }`.
5. **merge:** If the *project folder* `git status` is dirty, return a structured error (`project_folder_dirty`) and do not merge. If clean, merge `variant.branch` into `base` in the project repo, push `base`. Return `{ mode, branch, base }`.

Record `base_branch` on `ThreadVariant` at creation time (the project `HEAD` when the worktree was added). Today `variant.rs` only stores `slug`, `path`, `branch`, `kind`. Existing variants without `base_branch` fall back to `main`, then `master`.

`gh` is required for PR modes. If `gh` is missing or unauthenticated, fail with a clear message (same idea as the existing `gh` capability note in `docs/WORKTREES.md`). Merge mode does not need `gh`.

Register the new RPCs on the local HTTP API **and** the relay bridge (`git.status` / `git.diff` already are). Remote web can ship the same button.

## UI

Shared control in `packages/chat-ui` (or `packages/ui` if it stays a dumb split button + menu):

- Hidden unless `thread.variant`.
- Pending state on the button; disable while a ship is in flight.
- Menu items as in the Polyscope screenshot, with one-line hints.
- Merge and push: disabled + hint when we already know the project folder is dirty (`git.status` without `thread_id`).
- Errors via existing toast.

Wire it from:

- `apps/desktop` `DesktopConversationPane` / `SessionHeader` children (left of `PanelToggles`).
- `apps/remote-web` `SessionHeader` children (left of Preferences).

Mobile v1: no button. Isolated copies are a desktop/daemon concern; mobile stays read-only on this.

Diff panel does **not** get a second copy of the button in v1. One obvious place.

## Safety

- Never commit or merge in the project folder except the explicit **Merge and push** path, and only when that folder is clean.
- Never force-push.
- Never delete the variant or the branch after ship.
- Commit only the isolated checkout. The project folder’s dirty files stay untouched.
- If push/PR fails after a commit, leave the commit; say so; user can retry.

## Docs and tests

- Update `docs/WORKTREES.md` section 3: the control lives in the session header, default is PR, merge refuses a dirty project folder.
- Daemon tests: dirty variant commits then PRs; merge refuses dirty project folder; merge succeeds when project folder is clean; missing `gh` fails PR modes clearly.
- Header tests: button absent without `variant`; menu actions fire the right mode; dirty-folder disables merge.

## Out of scope

- Same-folder “open a PR from whatever branch I’m on”.
- Commit-message editor, file-by-file staging, amend.
- Auto-deleting variants after merge.
- Setup/archive scripts, copy-on-write clones.
- Custom merge/PR prompt templates.

## Suggested build order

1. `ThreadVariant.base_branch` + persist/read compatibility.
2. Daemon `git.commit` + `thread.ship` (merge + pr + draft) with tests.
3. Shared header split button.
4. Desktop + remote-web wiring and toasts.
5. Docs.

Protocol first (`falcondeck-core`, `client-core`), then daemon, then UI — same fan-out rule as other shared changes.

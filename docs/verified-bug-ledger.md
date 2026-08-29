# Verified Bug Ledger

This ledger supports the long-running goal to find and fix 100 verified FalconDeck bugs or concrete correctness issues. An item is counted only after its trigger is reproduced, its root cause is established, and its fix passes a focused regression check. Product and test-infrastructure issues are identified separately.

## Progress

- Verified and fixed: 2 / 100
- Product defects: 0
- Test-infrastructure defects: 2

## Verification Standard

Each entry records:

1. The exact failing test, command, runtime reproduction, or browser/native QA.
2. Root-cause evidence from the actual code path.
3. The scoped fix.
4. The passing regression command or documented QA.
5. The autoreview result for the fix commit containing the item.

## Verified Fixes

### 001 — Client-core normalization test breaks the root typecheck

- Kind: Test infrastructure
- Reproduction: `npm run typecheck` fails with TS18048 at `packages/client-core/src/normalization.test.ts:27-28`.
- Root cause: `WorkspaceAgentSummary.capabilities` is intentionally optional at the wire boundary, but the new regression test dereferenced it directly even though it was testing the normalizer's runtime guarantee.
- Fix: Assert the normalized capability object with `toMatchObject`, preserving both the wire type and the runtime assertion.
- Verification: `npm run typecheck` passes across all workspaces; `npm run test --workspace packages/client-core -- --run src/normalization.test.ts` passes all 44 tests.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings.

### 002 — DA1 PTY integration test depends on shell-specific echo rendering

- Kind: Test infrastructure
- Reproduction: `cargo test --workspace` fails in `terminal::tests::da1_query_is_answered_at_the_pty_boundary`; the captured output contains the daemon reply as `\u{7}1;2c` instead of the expected `^[[?1;2c`.
- Root cause: The test sent the reply to an interactive prompt and assumed the tty would caret-echo the escape bytes. The active shell line editor consumed the escape prefix and rendered a bell instead, even though the captured remainder proved that the daemon wrote the response.
- Fix: Keep the shell command in raw mode long enough to read all seven reply bytes and assert their hexadecimal representation directly.
- Verification: `cargo test -p falcondeck-daemon terminal::tests::da1_query_is_answered_at_the_pty_boundary -- --exact` passes and directly observes `1b 5b 3f 31 3b 32 63`.
- Autoreview: `.agents/skills/autoreview/scripts/autoreview --mode local` — clean, no accepted/actionable findings.

## Pending Verification

None yet.

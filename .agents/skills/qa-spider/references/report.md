# Report and artifacts

Read when creating the report and whenever you log a bug.

## Locations

Pick a run slug from the date plus focus, lowercase hyphenated. Examples: `2026-09-mobile-ux`, `2026-09-desktop-full`, `2026-09-onboarding`.

| Thing | Path |
| --- | --- |
| Report | `docs/qa/<run-id>-audit.md` |
| Screenshots | `qa-artifacts/<run-id>/` |
| Prior audits | anything already under `docs/qa/` |

Create both at the start. Do not commit them unless asked.

Screenshot names: `NN-short-slug.png` (zero-padded, incrementing). Bug evidence can reuse the page screenshot or add `NN-bug-short-slug.png`.

Browser session name: `qaspider` unless a prior run in this conversation already owns a session — then keep using that one.

## Create the file before testing

Copy this skeleton, fill the header, leave the inventory table ready for rows:

```markdown
# QA spider — <product> — <run-id>

- Origin: <frontend url>
- API: <api url or n/a>
- Viewport(s): <WxH>
- Session: `agent-browser --session qaspider` (or the driver you used)
- Auth: <users / impersonation method>
- Theme: <as loaded>
- Artifacts: `qa-artifacts/<run-id>/`
- Design baseline: <skill or AGENTS.md path, or "none found">
- Prior audit: <path and last bug ID, or none>

## Resume

Next row: <path> @ <viewport> as <user>
Last finished: <path or "inventory only">
Blocker: <none or one line>

## Continuation goal

Goal
Finish the QA spider in `docs/qa/<run-id>-audit.md`: every inventory row has PASS/FAIL/BLOCKED/SKIPPED with protocol evidence. Document only; do not fix.

Done means
- Inventory count N is the denominator; numerator is rows with a status.
- Each finished row has screenshot, overflowX, console note, interaction checklist, design notes, and a results line.
- Bugs use the template below; known IDs from <prior> are reused.

Between iterations
- Open Resume, take the next empty-status row, run the per-route protocol, log, update Resume, continue.
- Do not rewrite the inventory. Do not complete the run while empty-status rows remain.

If blocked
- Leave the row BLOCKED with reason, fixture, and smallest unblocker. Continue with the next row unless the blocker is global (stack down).

## Severity

- **P1** blocks a core journey
- **P2** degraded UX with a workaround
- **P3** polish / visual

## Bug log

(append as confirmed)

## Inventory

Estimated rows: N (before testing). Core journey first if N > 50; tail remains.

| # | Path / variant | Viewport | Auth | Category | Status | Interactions (tested/found) | overflowX | Screenshots | Notes |
| - | -------------- | -------- | ---- | -------- | ------ | --------------------------- | --------- | ----------- | ----- |

## Route results

(append one subsection per row)

## Completion

(only when every row has a status)
```

## Bug entry

```markdown
### B-NN [P1|P2|P3] <short title> | <route>

Steps: minimal repro (viewport, auth, exact clicks)
Expected: ...
Actual: ...
Evidence: `qa-artifacts/<run-id>/<file>.png` (+ console/network if relevant)
```

Rules:

- Next ID after the highest existing `B-NN` in this file or the prior audit you are continuing.
- One idea per entry. Split "tabs overflow and the save button no-ops" into two.
- Self-contained: another agent should not need this chat.
- Re-verified known bug: do not mint a new ID. Add a line under the original: `Re-verified YYYY-MM-DD: still occurs. Evidence: ...`

## Per-route subsection

```markdown
### R-<n> `<path>` @ <WxH> — <STATUS>

Auth: <user>
overflowX: <px>
Console: <none new | summary>
Screenshots: `...png`
Design: <anomalies or "no anomalies">
Interactions found: N
- [x] <control> — <result>
- [x] <control> — <result>
- [ ] <control> — SKIPPED: <reason>
```

## Completion section

```markdown
## Completion

- Rows: tested A / total N (FAIL x, BLOCKED y, SKIPPED z)
- Bugs: P1 a, P2 b, P3 c
- Fix first: B-.., B-.., B-.., B-.., B-..
- Untested: <none, or list with why>
```

## Resume discipline

Rewrite the Resume box after every row. If context is dying, that box plus the inventory table is the handoff. Do not paste a prose recap instead of updating the file.
---

---
name: qa-spider
description: Extensive document-only UI QA spider. Inventory every reachable route or screen, then drive the real UI in a browser route-by-route and interaction-by-interaction, logging each bug with a screenshot. Use when the user asks for a full QA pass, QA spider, route-by-route audit, UX/UI audit, test every page, spider the app, exhaustive QA, mobile or desktop QA sweep, or runs /qa-spider. Do not use for a single-bug repro, a one-flow smoke test, or to implement fixes (this skill documents only).
---

# QA Spider

Long-running, document-only UI audit. Find bugs by actually using the product. Do not fix code. Do not open issues unless asked. Do not commit the report or screenshots unless asked.

The inventory is the contract. You are not done until every inventory row has a result. Screenshot-only page loads are not testing.

## Related skills

Load these when they exist in the current project or harness:

- `automated-qa-testing` (or equivalent): test users, local-login, fixtures, browser gotchas. Read it during bootstrap, before judging any flow.
- `frontend-design` (or equivalent): design tokens and UI rules. Read it before the first design review.
- `goal-writer`: optional, after inventory, if you want a copyable continuation contract. The report Resume box is still required.
- `ntfy`: notify when the inventory is frozen, on a hard blocker, and at completion.
- `publish-report`: only if the user wants a phone-friendly link at the end.

## Hard rules

1. Document only. Do not change application code, CSS, copy, or tests.
2. One persistent browser session for the whole run. Do not fan out route testing to subagents; they will fight over the session and skip interactions.
3. One idea per bug. Each entry must be enough for a different agent to fix without re-deriving the repro.
4. Log a bug the moment you confirm it. Do not batch-write findings at the end.
5. Re-verify known bugs from prior `docs/qa/` audits when you hit those routes. Reuse their IDs; do not renumber.
6. If a row cannot be tested, write `BLOCKED` or `SKIPPED` with the reason. Silent skips are a skill failure.
7. Do not mark a route done because a nearby route "looked the same".
8. Do not stop after N bugs, after the core journey, or because the report "looks substantial". The denominator is the inventory count.

## Workflow

0. If `docs/qa/` already has an in-progress report for this request (Resume points at a next row, empty-status inventory rows remain), reopen that session and continue there. Do not rebuild the inventory.
1. Scope (ask only if the user did not already say).
2. Bootstrap the project, stack, design system, and browser session. Read [references/browser.md](references/browser.md).
3. Build the full route/screen inventory and write it into the report **before any testing**. Read [references/inventory.md](references/inventory.md) and [references/report.md](references/report.md).
4. Freeze a continuation goal and a todo list with **one item per inventory row**.
5. Test **one row at a time** with the per-route protocol. Read [references/per-route.md](references/per-route.md) before the first row and keep following it.
6. After every row: update the report, tick the todo, point Resume at the next pending row, continue.
7. Stop only at the completion gate.

## 1. Scope

If the user's message already names the target, viewport, or focus (for example "mobile onboarding", "desktop billing", "full spider at 390px"), do not re-ask. Proceed.

If they only invoked the skill or asked for a vague "QA pass", ask at most these, in one message, then wait:

- Focus: full app, or a named area / journey?
- Viewport(s): narrow (~390x844), medium (~768x1024), wide (~1440x900), or more than one?
- Anything to skip, any known-broken environment, any existing `docs/qa/` audit to continue?

Do not ask about severity scales, templates, or process. After answers (or a specific initial brief), do not ask permission to continue.

Treat each requested viewport as a dimension on the inventory (same path can be two rows). Do not default to mobile or desktop when they did not say.

## 2. Bootstrap

1. Read root `AGENTS.md`. Then the nearest frontend `AGENTS.md` if present.
2. Load the project's browser-QA skill and design-system skill when they exist.
3. Discover frontend origin, API origin, health checks, and the documented dev-start command. A common local shape is a Vite/React app on `:5173` and a Laravel API on `:8000` — confirm from this repo, do not assume.
4. Start the stack only if health checks fail. Wait for a real 200, not a process spawn.
5. Create artifact dirs (see [references/report.md](references/report.md)). Create the report file up front with the severity key, bug template, empty inventory heading, and Resume box.
6. Open one browser session at the agreed viewport(s). Dismiss cookie/consent/NPS overlays before interacting with page content.
7. Auth: use the project's documented impersonation / local-login / test users. Manual login only when the login form itself is under test. For signup QA, use a unique throwaway address. Do not reset shared fixtures as preflight.

If a prior audit exists for this app, read it. Continue numbering from the last bug ID. Note environmental caveats so you do not re-log them as new product bugs.

## 3. Inventory (blocking)

Do not navigate-and-judge random pages yet.

Build the complete reachable-route list, write it into the report as a checklist, and estimate the count. Include:

- Declared router paths (auth, layout, name)
- Query/state variants that change the UI
- Auth/plan/role variants when the same path renders differently
- Empty / first-run / paywalled / context-required variants when they are distinct screens
- Routes found by spidering nav, sidebar, footer, account menus, and in-product CTAs that the static list missed

Categorise each row: anonymous, authed, role/plan-gated, admin, context-required.

If there are more than ~50 rows, **reorder** so the core user journey and onboarding come first. Do not delete the tail. The tail stays in the checklist.

Read [references/inventory.md](references/inventory.md) for extraction and row rules.

## 4. Freeze the run (blocking)

The inventory is useless if the agent "finishes" after a handful of pages. Immediately after writing it:

1. Put a continuation goal in the report (template in [references/report.md](references/report.md)). Done means: every inventory row is `PASS`, `FAIL`, `BLOCKED`, or `SKIPPED`, each with protocol evidence.
2. Create todos: **one per inventory row**, in the report order. The current row is `in_progress`. Never a single todo named "QA the app". If the todo tool caps count, keep the next batch of ~10 plus the current row, and treat the report checklist as canonical.
3. Set the Resume box to the first pending row: path, viewport, auth user, next action.
4. Tell the user one line: inventory count and the first path. Start that row in the **same turn**. Do not stop for approval.

## 5. Per-route loop

For every row, in order, with no batching:

1. **Navigate.** Full screenshot. Measure horizontal overflow. Read console.
2. **List interactions** from a fresh interactive snapshot *before* clicking. Write that checklist into the report.
3. **Design review first** against the design system — anomalies even when nothing is "broken".
4. **Exercise every listed control.** Assert a state change (URL, text, snapshot). Happy path plus one failure path per form. Open/close/scroll overlays at the current viewport.
5. **Log bugs as they happen.** Write the route results line. Then the next row.

A route todo may be completed only when every interaction on that row is tested or explicitly skipped with a reason.

PASS criteria and the interaction taxonomy live in [references/per-route.md](references/per-route.md).

## 6. Completion gate

You may write the final summary only when every inventory row has a status. The summary must include:

- Rows tested / total (and BLOCKED / SKIPPED counts)
- Bugs by severity
- The 5 issues you would fix first, with IDs
- What remains untested and why
- Viewport(s), session name, report path, artifact dir

If you run out of context, update Resume and stop mid-loop. A partial report with a next-row pointer is correct; a premature "done" is not.

## Anti-patterns (these mean you drifted)

- Closing after the core journey while later rows are still pending
- Passing a route from a screenshot without an interaction checklist
- Testing only primary CTAs and ignoring tabs, menus, empty states, and failure paths
- Relogging known benign console noise
- Fixing CSS "while you are here"
- Parallel browser sessions or subagent spiders
- Asking "want me to continue?" after the inventory is frozen
---

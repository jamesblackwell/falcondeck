---
name: goal-writer
description: Investigate rough objectives and turn them into clean, verifiable agent goals or task prompts for longer-horizon work.
---

# Goal Writer

Turn a rough objective into a copyable, verifiable work contract another agent can run after "continue", "implement", or similar.

Use when asked to write, expand, rewrite, or generalize a goal, prompt, task brief, or longer-horizon agent instruction. Aim to reduce back-and-forth by investigating enough up front to define done and proof.

Do not run the generated goal unless explicitly asked in the same turn. A later "continue", "implement", "run it", or similar means execute the latest generated goal unless scope changed.

For product, rollout, AI-output, quality, UX, or growth work, prefer a small numeric rubric over vague "improve" language. Define the sample source, 3-7 criteria, pass/fail threshold, stop condition, and decision vocabulary where relevant: continue, narrow, pause, instrument first, or fix now.

## Workflow

1. Decide whether investigation is needed.
   - For non-trivial code, product, QA, debugging, ops, or research: inspect relevant files, docs, tests, logs, commands, issues, or source material first.
   - For simple wording-only prompts, use given context and stay short.
2. Keep investigation focused.
   - Gather enough to identify likely work areas, constraints, verification, and risks.
   - Prefer repo docs, existing scripts, tests, and local conventions over generic advice.
   - Label anything that is inferred, approximate, stale, blocked, or unchecked.
   - In the goal, list what was actually inspected: files, routes, commands, docs, dashboards, traces, screenshots, tickets, or source material. If nothing was inspected, say so; do not present inferred paths/commands as facts.
3. Ask obvious unknowns up front.
   - Ask only when the answer changes scope, safety, done criteria, or verification. Prefer 1 question; max 3.
   - If a required verification artifact is missing, ask before a runnable goal: Figma link, screenshot, fixtures, production window, sample source, rubric source, etc.
   - Otherwise assume reasonably and label it.
4. Define done before defining work.
   - State observable end state, acceptance criteria, and explicit out-of-scope bounds.
   - Phrase success so the implementing agent stops when evidence matches.
   - For subjective UX/cleanup/"feels off" tasks, define a fixed baseline checklist or sample before edits. Avoid "find 3-5 issues" unless evidence to start, stop, and no-high-confidence handling are explicit.
5. Make verification mandatory and as objective/scientific as possible.
   - Golden rule: pick checks that make the agent as confident as reasonably possible, given risk, tools, and cost.
   - Usually mix complementary checks for different failure modes; do not pretend one check proves all.
   - Prefer direct proof where it fits: unit, feature/integration, type/static checks, browser automation/screenshots, Figma/screenshot comparison, API checks, Grafana/OTel traces/metrics, logs, benchmarks, source inspections.
   - In this repo, when confidence depends on daemon/relay runtime behavior, prefer local daemon runs, relay test fixtures, or read-only SSH/Ansible checks on the production relay host over assumptions.
   - For subjective work (AI output, code review, visual QA, writing, strategy), use LLM-as-judge when useful: subagents with rubric, scale, pass/fail examples, and specific findings.
   - Do not list every possible check. Include selected checks only, with why each raises confidence.
   - If full proof is impractical, define the strongest cheap proxy and what remains unproven.
   - Name expected evidence; include falsifying evidence when useful.
   - Define confirmed, partial, blocked, failed, or uncertain if evidence may be incomplete.
6. Avoid excessive verification loops.
   - Start with the smallest check covering risk; broaden only for shared behavior or material uncertainty.
   - State when to stop: done criteria met, planned checks pass, or bounded failed attempts with evidence.
   - For review/subjective evaluation, gate edits behind baseline evidence, threshold, and identified change surface.
   - For broad cleanup, choose the highest-confidence measured issue or stop with baseline evidence. No polish hunting after the selected issue is fixed.
7. Use concrete, data-bearing language.
   - Avoid weasel or peacock words such as improve, better, simpler, clearer, faster, robust, urgent, many, often, great, best-in-class, and high quality unless they are tied to a metric.
   - Use absolute dates, named files/routes/classes, counts, percentages, thresholds, units, sources, and before/after baselines.
   - If the baseline is unknown, make measuring it the first step or ask the user for the target. Do not invent precision.
8. Keep the goal narrow enough to audit but broad enough for the implementing agent to discover the next action.
9. Keep the generated goal concise.
   - Target 1,000-1,200 characters. Treat 1,500 as the normal ceiling and 2,000 as the hard maximum.
   - Prefer 5-8 bullets total for normal tasks.
   - Use at most 5 sections: `Goal`, `Done means`, `Investigation`, `Verification`, and `If blocked`. Add another section only when it prevents a likely mistake.
   - Include only high-signal inspected files/facts; list a file only if it changes scope, done criteria, or verification.
   - If over budget, compress first: merge sections, group files/checks, drop `Preserve`/`Use`/`Assumptions`, and keep only decisive verification evidence.
10. Keep the output copy-clean.
   - Return only the fenced `text` block unless you must ask a blocking question.
   - Do not add preamble such as "Here is a stronger version", "Sure", or explanatory text before or after the block.
   - If a blocking question is required, ask only the question and do not include a goal block.
11. For major changes in this repo (new features, protocol/API changes, cross-package refactors, releases), include the `AGENTS.md` autoreview rule: run `.agents/skills/autoreview/scripts/autoreview --mode local` before commit or handoff, and record the command and result in the handoff.

## Output

Return exactly one fenced plain-text block. Target 1,000-1,200 characters; stay under 1,500 unless truly necessary; never exceed 2,000. No lead-in or trailing text. Do not prefix `/goal` unless explicitly asked.

If required info is missing, return only the concise blocking question.

Use 1-2 bullets per section. Omit optional sections aggressively. If the draft would exceed 2,000 characters, rewrite shorter before returning it.

Default shape:

```text
Goal
<desired end state>

Done means
- <observable acceptance criteria and explicit out-of-scope boundaries>

Investigation
- <what was actually inspected: files, commands, docs, routes, dashboards, traces, screenshots, tickets, or source material>
- <confirmed facts from inspection; label inferred or unchecked facts>

Verification
- <1-2 selected checks and why they cover the main failure modes>

If blocked
- Stop with <attempts, evidence, blocker, and smallest next input needed>
```

Optional sections: `Preserve`, `Use`, `Between iterations`, `Assumptions`, `Missing detail`. Add only if high-risk or necessary. Keep bullets concrete/testable. Prefer numbers and named evidence over adjectives.

## Templates

Templates show what to include when relevant; do not copy all sections. Compress to the 1,000-1,500 character target.

Backend/API feature:

```text
Goal
Implement <endpoint/job/service behavior> for <named route/job/class> so <measurable user or system outcome> is true.

Done means
- <Named endpoint/job/service> accepts <inputs> and returns/emits <exact response/event/state>.
- Backward compatibility is preserved for <existing route/resource/event>.
- Error handling covers <N> listed failures with expected status codes, messages, retries, or job states.

Verification
- Unit tests for <logic/class> covering <N> edge cases; proves isolated rules.
- Feature/API tests for <route/job/workflow> covering success, auth, validation, and one failure; proves framework contract.
- If runtime confidence matters, run the daemon/relay locally or use read-only SSH checks on the production relay host for <absolute window>; report concrete counts, statuses, or log evidence.

Preserve
- V1 API behavior remains unchanged; V2 responses stay snake_case and wrapped in `data` when applicable.

Between iterations
- Run smallest failing test first; widen only for shared contracts; stop when done criteria and checks pass.

If blocked
- Stop with failing command/query, expected result, actual result, missing data/access, and the smallest decision needed.
```

UI/design implementation:

```text
Goal
Implement <screen/component/flow> so it matches <Figma URL/screenshot/spec> within <explicit tolerance or acceptance criteria>.

Done means
- <N> required states are implemented: <states>.
- Desktop viewport <size> and mobile viewport <size> have no text overlap, clipped controls, broken navigation, or console errors.
- Visual differences from <Figma/screenshot/spec> are limited to <explicit allowed differences>.

Verification
- Run <component/unit tests> for state logic; proves non-visual behavior.
- Use browser automation for <N> viewports and required interactions; proves rendered flow.
- Capture screenshots and compare with <Figma/screenshot/spec>; record remaining pixel/layout differences by viewport/component.

Preserve
- Existing routes, API calls, accessibility labels, loading/error states, and design-system conventions.

Between iterations
- Fix largest visible mismatch first; rerun smallest screenshot/browser check; stop when criteria are met.

If blocked
- Stop with viewport, screenshot path, expected result, actual result, and missing design/product decision.

Missing detail
- If <Figma URL/screenshot/spec> is missing, ask before returning a runnable goal.
```

Subjective UX cleanup:

```text
Goal
Measure <screen/flow/component> against a fixed checklist, then fix the highest-confidence evidence-backed issue that blocks <named user outcome>.

Done means
- Baseline is captured before editing for <N> named scenarios across <viewport/device/state list>.
- Each scenario is PASS, FAIL, or BLOCKED against <checks: clipped controls, unclear selected state, missing validation, dead end, console error>.
- Implement only issues with direct evidence and a local change surface in <paths>.
- If the baseline has 0 FAIL items or only low-confidence preferences, stop with the evidence and no code changes.
- Out of scope: <related redesigns, APIs, pricing/auth/generation, or other broad areas>.

Verification
- Browser/simulator automation for named scenarios/viewports; proves rendered workflow.
- Before/after screenshots for each changed scenario; proves visible fix.
- Focused component/unit tests for changed state, validation, navigation, or data handling; proves behavior beyond screenshots.

Between iterations
- Fix one evidence-backed issue at a time; rerun smallest failed check; stop when selected failures pass or remaining items need product/design.

If blocked
- Stop with scenario, viewport/device, expected result, actual result, evidence path, and the smallest decision or test data needed.
```

Refactor:

```text
Goal
Refactor <module/class/area> so <measurable maintainability target> is true without changing external behavior.

Done means
- Baseline first: LOC, duplicate call sites, complexity, runtime, or another relevant metric.
- Final state meets target: touched files <=400 LOC, duplicate logic from <N> spots to 1 helper, or <named command> runtime within <baseline + 5%>.
- Named public APIs/routes/events remain compatible.
- 0 unrelated files are changed outside <paths>.

Verification
- Run <focused tests/typecheck/static checks>; proves behavior/contracts did not regress.
- Compare diff, `wc -l`, `rg` counts, or benchmark output against baseline/target; proves measurable refactor target.

Preserve
- Public APIs, data contracts, user-visible behavior, and existing framework conventions.

Use
- <repo paths/docs/tests>.
- Commit only scoped files with the repo commit helper if committing is requested or expected by repo rules.

Between iterations
- Inspect failing checks/diff risk first; make one focused change; rerun smallest relevant check; stop when criteria are met.
- Record deferred follow-up in TODO/docs; use repo decision log for long-feature decisions outside plan.

If blocked
- Stop with files inspected, attempted checks, exact failure, and the smallest decision needed.
```

QA sweep:

```text
Goal
Complete a QA sweep of <feature/routes/workflow> covering <N> required scenarios from <source> and classify each scenario as CONFIRMED, PARTIAL, BLOCKED, or FAILED.

Done means
- 100% of listed scenarios have evidence-backed classifications.
- Failures and blockers include exact route/action, expected result, actual result, and evidence.
- No destructive production action was taken.

Verification
- Use browser/API evidence for each scenario; proves workflow result.
- Use screenshots or logs only when they prove state that browser/API assertions do not capture.
- Return a concise final checklist with one evidence item per scenario.

Preserve
- Test data and production safety; avoid destructive production actions unless explicitly approved.

Use
- <local URLs/test users/API fixtures>.

Between iterations
- Verify auth/bootstrap first; test highest-risk path; capture evidence; move to next uncovered item.
- Stop when required checks are classified or a blocker prevents evidence-backed coverage.

If blocked
- Stop with the route/action, expected result, actual result, evidence, and unblocker.
```

Production investigation:

```text
Goal
Investigate <production symptom> during <absolute UTC window> until the likely root cause and next action are supported by evidence.

Done means
- Impact is quantified with request/user/error counts, latency percentiles, revenue/cost estimate, or clear "not available".
- Confirmed facts, ruled-out causes, likely cause, confidence level, and next safest action are documented.
- The conclusion is backed by at least 2 independent signals, or clearly labeled uncertain.

Verification
- Use <primary signal> because it directly measures <symptom>.
- Use <second independent signal> because it corroborates or falsifies the primary hypothesis.
- Use extra Grafana/Sentry/logs/DB/API checks only for a specific hypothesis.

Preserve
- Do not make production data changes or risky deploys unless explicitly approved.
- Keep queries read-only and scope the time window.

Between iterations
- Form one hypothesis; query cheapest reliable signal; update evidence; discard/refine.
- Stop when next action has evidence or missing access/data blocks progress.

If blocked
- Stop with confirmed facts, ruled-out causes, missing access/data, and the next safest check.
```

Subjective output evaluation:

```text
Goal
Evaluate <AI output/code/writing/UX> against <rubric/source>, then implement changes only if the baseline misses the target and the likely change surface is identified.

Done means
- The sample source is fixed and repeatable: <fixture path/query/export/user-safe sample source>.
- <N> samples scored 1-5 for <criteria>; define scores 1, 3, and 5.
- Critical criteria are named explicitly: <criteria>.
- Pass threshold is explicit: average >=4.0, no critical criterion <3, and >=80% samples pass.
- Code/content changes only after baseline misses threshold and failures trace to <prompt/parser/service/UI/content source>.
- Any subagent judge disagreement >1 point is summarized with the exact criterion and sample id.

Verification
- Dispatch <N> independent subagents with same rubric/sample ids and no access to each other's scores; reduces judge bias.
- Return score table, failed examples, and smallest change likely to move each failed criterion over threshold.

Between iterations
- Change one rubric area at a time; rescore smallest representative sample; stop when threshold passes, baseline passes, or remaining failures need product.

If blocked
- Stop with the rubric, sample source, scores, disputed criteria, sample ids, and the decision needed.

Missing detail
- If <rubric/source> or repeatable sample source is unavailable, ask for it before returning a runnable goal.
```

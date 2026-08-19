---
name: deep-investigation
description: Use only when the user explicitly requests a deep investigation, deep dive, thorough investigation, or similarly exhaustive analysis. Do not invoke solely because a task is complex or research-heavy.
---

# Deep Investigation

Use this skill only when the user explicitly asks for a deep investigation, deep dive, thorough investigation, or similarly exhaustive evidence-first analysis.

Do not infer the trigger from task complexity alone. Complex edits, debugging, architecture, strategy, and research-heavy questions should use the normal workflow unless the user explicitly requests this depth of investigation.

## Core Principle

Do not merely produce a plausible answer. Build an informed answer.

Reduce uncertainty by deliberately gathering the right context, exploring the problem from multiple angles, testing assumptions, and only then synthesizing a recommendation.

Prefer evidence over intuition. Prefer reading the codebase over guessing. Prefer checking the actual implementation over relying on naming, comments, or assumptions. Prefer stating uncertainty over hiding it.

The phases below are a workflow, not a menu. Work through them in order unless the task is genuinely small enough that collapsing phases is obviously harmless. If you collapse phases, still preserve the underlying work: clarify the goal, frame the investigation, gather evidence, synthesize, critique, and answer.

For non-trivial investigations, keep a lightweight working ledger while you work. It can stay private unless useful to the user, but it must track:

- the current interpretation of the request;
- the goal or decision criteria that define a useful answer;
- a todo list of investigation steps with current status;
- investigation tracks being pursued;
- evidence checked so far;
- key findings and contradictions;
- assumptions and uncertainty;
- candidate recommendations;
- critique gaps to revisit.

Do not skip directly from reading one file, one log line, or one search result to a final recommendation unless that single artifact genuinely settles the question.

## Phase 1: Clarify The Problem

First, inspect the user's request and classify it:

- **Clear**: the goal, scope, and success criteria are obvious.
- **Mostly clear**: the likely goal is clear, but there are some assumptions.
- **Ambiguous**: multiple materially different interpretations are possible.
- **Underspecified**: continuing would waste significant time or risk answering the wrong question.

If the request is clear, continue.

If the request is mostly clear, briefly restate the interpretation before continuing:

```text
I'll treat the question as: [concise restatement]. I'll proceed on that basis unless the evidence points elsewhere.
```

If the request is ambiguous or underspecified, ask a short clarifying question before doing the full investigation. Do not ask for clarification if a reasonable assumption would let you make useful progress and the cost of being slightly wrong is low.

When asking for clarification, ask only the minimum necessary question.

Before leaving this phase, make sure you can state:

- the decision or understanding the user needs;
- what is in scope and out of scope;
- whether the task is read-only analysis, implementation, debugging, or recommendation.

If you cannot state those, do not proceed as if the problem is clear.

## Phase 2: Frame The Investigation

Before researching or changing anything, break the problem into explicit investigation tracks.

Choose only the tracks that fit the task. Common tracks include:

- User goal: what outcome is actually needed?
- Current behavior: what happens now?
- Desired behavior: what should happen instead?
- Code reality: where is this implemented?
- Data/model reality: what data structures, schemas, APIs, or state are involved?
- System constraints: performance, security, cost, reliability, compatibility, UX, deployment.
- Prior art: existing patterns in the codebase or external best practices.
- Failure modes: what could go wrong?
- Alternatives: what are the plausible approaches?
- Decision criteria: what makes one option better than another?

If useful, create a short working plan with the tracks to investigate.

For complex work, do create the plan. It should be short, concrete, and tied to evidence sources. Avoid vague plans like "look into this"; prefer tracks such as "trace call sites", "inspect tests that encode behavior", "check production docs for intent", and "identify refactor boundaries".

For substantial investigations, write an explicit goal and todo list before deep work begins. The goal should define what a good answer must decide or explain. The todo list should be operational, not decorative: update it as steps are completed, blocked, or replaced by better evidence paths. If the user's environment provides a task-list or planning tool, use it when the investigation has multiple steps or will take more than a few minutes. If no tool is available, keep the list in the working ledger and summarize progress to the user when helpful.

Before gathering evidence, decide what would change your mind. Examples:

- a caller requires the current coupling;
- tests encode behavior that rules out a proposed simplification;
- docs reveal an intentional product constraint;
- logs or metrics show the suspected issue is not happening.

## Phase 3: Gather Evidence

Investigate before concluding.

Use the available tools to gather relevant evidence. Depending on the task, this may include:

- reading relevant source files;
- tracing call paths;
- inspecting tests;
- searching for related components, routes, jobs, migrations, config, prompts, docs, issues, or logs;
- checking recent changes;
- running tests, type checks, linters, or targeted commands;
- consulting external docs or references when current behavior depends on third-party tools, APIs, libraries, pricing, specs, or standards.

When reading a codebase, do not stop at the first matching file. Follow the flow far enough to understand the real behavior.

Evidence gathering has a minimum bar:

- Check the primary artifact directly.
- Check at least one upstream caller or input source when behavior depends on how the artifact is invoked.
- Check at least one downstream consumer or output path when behavior depends on persisted state, UI, API, metrics, or generated artifacts.
- Check tests, fixtures, docs, history, logs, or metrics when they are relevant to the claim.
- If a category is relevant but not checked, record why.

For code investigations, prefer this order:

1. Read the target file.
2. Search for call sites and related types.
3. Read tests that cover the target behavior.
4. Inspect adjacent services/models/config/schema that define the contract.
5. Check docs or recent commits when intent or rollout history matters.
6. Run a focused verification command when it is cheap and safe.

Keep lightweight notes as you go:

- Key findings
- Supporting evidence
- Open questions
- Assumptions
- Possible approaches
- Risks or edge cases

If the investigation becomes too large, narrow the scope around the user's actual decision or next action.

Do not treat absence of evidence as evidence of absence until you have searched the likely names, paths, and concepts. If search terms are uncertain, try synonyms and domain terms.

## Phase 4: Use Sub-Agents Selectively

Use sub-agents only when they create real leverage.

Good sub-agent tasks are discrete, parallelizable, and independently checkable, such as:

- Trace how billing limits are enforced.
- Compare three implementation approaches.
- Review this proposed plan for failure modes.
- Search the codebase for all usages of this concept.
- Check external documentation for the current API behavior.

Bad sub-agent tasks are vague or overlapping, such as:

- Think about this.
- Research everything.
- Find issues.
- Solve the whole problem.

When using sub-agents, give each one:

- a narrow question;
- exact files, terms, or areas to inspect if known;
- expected output format;
- instruction to cite evidence or point to files;
- instruction to distinguish facts from assumptions.

Do not blindly trust sub-agent output. Treat it as input to be checked and synthesized.

If sub-agents are unavailable, disallowed, or unnecessary, continue directly. Do not use the lack of sub-agents as a reason to skip evidence gathering.

## Phase 5: Synthesis Pass

Combine the evidence into a coherent working answer.

At this stage, explicitly identify:

- what is known;
- what is inferred;
- what remains uncertain;
- which options are viable;
- which options should be rejected;
- what trade-offs matter.

For technical decisions, prefer a recommendation that fits the existing system rather than an abstract "best practice".

For debugging, prefer the simplest explanation that matches the observed evidence, but check for at least one alternative explanation.

For product or strategy questions, separate user value, implementation cost, risk, and reversibility.

The synthesis must connect recommendations back to evidence. A useful synthesis says "because X and Y were observed, option A is safer than option B." Avoid conclusions that could have been written before the investigation.

When multiple explanations or approaches are plausible, compare them explicitly. Reject options with reasons, not vibes.

## Phase 6: Critique Pass

Before giving the final answer, perform a critique pass.

Ask:

- What assumption could make this answer wrong?
- What evidence is missing?
- Have I checked the actual code, path, or data, or am I guessing?
- Is there a simpler explanation or solution?
- Are there hidden edge cases?
- Are there security, privacy, performance, billing, migration, or backwards-compatibility risks?
- Would a senior engineer or product lead challenge this?
- Is the recommendation over-engineered?
- Is the recommendation under-specified?
- What would I test before shipping?

If the critique reveals important gaps, go back to Phase 3 and investigate those gaps.

Repeat the gather -> synthesize -> critique loop until either:

- the answer is well-supported; or
- the remaining uncertainty is not worth resolving within the task.

This phase is mandatory for non-trivial work. Do not skip it because the first synthesis feels right. At minimum, challenge:

- the strongest assumption in the answer;
- the most likely hidden caller, user, data, or operational edge case;
- whether the recommendation is too broad for the evidence;
- whether a smaller reversible step would achieve the same goal.

If the critique changes the answer, say so in the final response only when it helps the user understand the recommendation.

## Phase 7: Final Answer

Produce a concise final answer that is more useful than the raw investigation.

Default structure:

1. Summary
2. Recommendation
3. Reasoning
4. Evidence
5. Trade-offs / risks
6. Next actions
7. Remaining uncertainties, if any

For simple outputs, collapse this structure.

Do not dump every thought. The user wants the result of deep thinking, not the full scratchpad.

Be explicit about confidence:

- **High confidence**: directly supported by evidence.
- **Medium confidence**: evidence is partial but points clearly in one direction.
- **Low confidence**: plausible, but more investigation is needed.

If recommending implementation work, include:

- the smallest safe first step;
- files or areas likely to change;
- tests or checks to run;
- rollback or mitigation considerations if relevant.

If the investigation shows the premise is wrong, say so directly.

The final answer should show that the phases were actually performed without dumping the whole ledger. Include enough evidence for the user to trust the result:

- cite the most important files, docs, commands, logs, or sources checked;
- distinguish observed facts from inference;
- call out meaningful uncertainty;
- state the smallest practical next step.

## Behavioral Rules

- Do not answer immediately just because an answer is easy to imagine.
- Do not perform a "fake investigation" by listing phases in the final answer without doing the work.
- Do not create a todo list and then ignore it. Use it to drive the investigation, revise it when evidence changes the path, and close it out before finalizing.
- Do not let the final answer get ahead of the evidence.
- Do not ask for clarification when a safe, useful assumption can be made.
- Do not research endlessly; optimize for decision quality.
- Do not let sub-agents create duplicated noise.
- Do not treat old docs, comments, or README claims as more reliable than current code.
- Do not hide uncertainty.
- Do not produce a long report when the useful output is a short recommendation.
- Do not modify code unless the user asked for implementation, or unless the current task explicitly includes making changes.

## Completion Checklist

Before finalizing, verify:

- The problem was correctly understood.
- A goal and todo list were created for substantial investigations, and the todo list was updated or deliberately collapsed.
- Each relevant phase was performed or deliberately collapsed for a stated reason.
- Relevant code, docs, or sources were checked where needed.
- Claims in the answer are traceable to evidence or clearly marked as inference.
- At least two plausible explanations or approaches were considered when applicable.
- Important assumptions are stated.
- Obvious risks and edge cases are covered.
- The recommendation is actionable.
- Remaining uncertainty is disclosed rather than disguised.

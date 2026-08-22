---
name: github-reference-finder
description: Find, evaluate, and report useful open-source GitHub reference implementations for a technical problem. Use when a user asks for existing code, open-source examples, prior art, a library comparison, or a proven implementation pattern before designing or building a feature.
---

# GitHub Reference Finder

## Overview

Find a small set of credible repositories or source-level examples that solve a problem closely enough to inform a concrete technical decision. Research is evidence, not permission to copy code or depend on a project.

Use the GitHub tool for repository and code inspection. Use the search tool to widen discovery, resolve terminology, find project documentation, and surface repositories that GitHub search misses. Prefer the GitHub tool for facts about a repository.

## Workflow

### 1. Frame the search

Turn the problem into a compact search brief before searching:

- Desired outcome and the important workflows or edge cases.
- Target stack, runtime, and deployment constraints.
- Whether the user needs a dependency, an architectural pattern, or code to study.
- License, maintenance, security, performance, and self-hosting constraints.

If these details are absent, infer only low-risk defaults from the project and state the assumptions in the result. Ask one concise question only if an unresolvable constraint, such as a required language or license policy, changes the answer materially.

### 2. Build a query set

Use 3–6 deliberately different queries, rather than repeating one broad phrase. Combine:

- Product or domain terms: `"feature name"`, user-facing vocabulary, protocol names.
- Implementation terms: data structures, algorithms, integrations, or UI primitives.
- Stack constraints: language, framework, runtime, database, or platform.
- Evidence terms: `example`, `demo`, `reference implementation`, `starter`, `self-hosted`.

Start with precise concepts. Broaden with adjacent terminology only after the first pass. Prefer a capability query such as `OAuth device authorization Go` over a vague query such as `best OAuth projects`.

### 3. Discover candidates

1. Search GitHub repositories first, applying language, topic, and activity filters when they matter. Search code when a project-level match is too broad or a specific pattern is needed.
2. Use the search tool to discover alternative terminology, tutorials that name mature projects, official project documentation, and relevant GitHub URLs.
3. Collapse obvious forks, abandoned experiments, generated mirrors, course exercises, and wrapper repositories. Keep the upstream project or the clearest implementation instead.
4. Shortlist 2–5 candidates. Do not select a result based on stars, a search snippet, or a README claim alone.

### 4. Validate each shortlist candidate

Inspect the repository directly with the GitHub tool. Read the README and the specific files implementing the relevant behavior. Check these facts:

- **Fit:** Does it implement the required workflow, rather than merely mention it?
- **Compatibility:** Does its language, framework, runtime model, or deployment model suit the target?
- **Code quality:** Is the relevant code understandable, bounded, and supported by tests or examples?
- **Health:** Is there meaningful maintenance activity, a usable issue history, releases, or signs the project is still viable? Treat activity as a signal, not a hard requirement for reference-only code.
- **License:** Identify the repository license and flag compatibility concerns. Do not give legal advice.
- **Risk:** Look for unsafe defaults, unmaintained dependencies, secret handling, insecure auth patterns, or a scope much larger than the requested problem.

For the strongest candidate, trace the relevant call path far enough to explain how it works. Link to the exact file and, when source-level details matter, use a commit-pinned permalink or clearly identify the reviewed revision.

### 5. Synthesize a recommendation

Classify each candidate as one of:

- **Adopt:** a credible dependency or starting point for the target context.
- **Study:** a useful pattern, but not an appropriate dependency.
- **Avoid:** a superficially relevant result with a concrete mismatch or risk.

Recommend one option—or state that none is sufficiently suitable—based on the user's constraints. Never imply a repository is production-safe without evaluating the relevant code and integration surface.

## Report format

Use this concise structure, adapting it to the request:

```markdown
## Open-source references

**Recommendation:** [repository or no-fit result] — [one-sentence reason].

| Candidate | Verdict | Why it fits / does not fit | Key caveat |
| --- | --- | --- | --- |
| [name](GitHub URL) | Adopt / Study / Avoid | ... | ... |

### What to take from the recommended implementation

- [Specific subsystem, file, or pattern] — [what it demonstrates].
- [Specific subsystem, file, or pattern] — [what to adapt or avoid].

### Validation notes

- License: [license or not found]
- Maintenance: [concise evidence]
- Compatibility assumptions: [only relevant assumptions]

### Search coverage

- Queries explored: [query families or exact queries]
- Exclusions: [forks, mismatched stacks, abandoned projects, or other meaningful omissions]
```

Link every recommendation to its repository and link source-level claims to the relevant file. Keep the report short; a well-supported top candidate and one viable alternative are more useful than a long, unranked list.

## Boundaries

- Do not clone, install, copy, or modify a repository unless the user explicitly asks.
- Do not recommend copying code before checking the license and the exact source context.
- Do not treat popularity, a marketing README, or a search-engine result as proof of implementation quality.
- If no candidate meets the constraints, say so, show the closest mismatches, and suggest a more targeted next search rather than forcing a recommendation.

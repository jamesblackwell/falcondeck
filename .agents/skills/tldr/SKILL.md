---
name: tldr
description: Condense verbose agent output or recent work into a 30-second executive summary — a single-line recap plus open decisions. Use when James asks for a TLDR.
---

# TLDR

James invokes this when he has a wall of verbose agent output and no time to read it. Produce a developer-to-CEO summary he can skim in under 30 seconds. Output the format below and nothing else — no preamble, no headers, no analysis, no caveats.

## Format

```
recap: <one flowing comma-separated sentence (two max) covering what was done, its current state (tests, commits, deploys), ending with the single next action>

decisions:

1. <open question that needs James's call>
2. <...>
```

## Example

```
recap: Homepage and all 39 landing pages got the copy tightening and hero polish, tests pass, everything is committed, pushed, and deployed live to testsetgo.com. Next action: give the ledes a quick editorial read via git diff when you're back.

decisions:

1. Do we want to launch this?
2. How frequent to backup?
```

## Rules

- The recap is prose, not bullets — one skimmable line.
- Plain language. No jargon, no file paths unless essential.
- Always state whether work is committed, pushed, and deployed, and what the next action is.
- `decisions` lists only genuine open questions needing James's input. If there are none, write `decisions: none`.
- Do not omit failures or uncertainty — fold them into the recap honestly (for example, "two tests still fail").

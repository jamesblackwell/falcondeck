# Token and cache efficiency review

7 Nov 2026. Read-only review: no code changed, no provider runs. Data window 3 Nov 14:15 to 7 Nov 16:37 UTC (4.10 days), scaled to a week by ×1.708.

All dollars are **list-equivalent**. The Claude CLI prices its `cost` field at API list price even on a subscription, so these figures show relative weight and rate-limit pressure, not an invoice. Codex and OpenCode report no cost and are not priced here. Their findings are in tokens.

## Ranked fixes

Baseline for this table: $3,576/week from the replay model (measured: $3,467 in transcripts, about $3,536 once hidden compaction calls are added). "Alone" is the saving if only that fix ships. "In order" is what it adds after the fixes above it, so that column can be summed. All savings are estimates.

| # | Fix | Alone /wk | In order /wk | Effort | Risk | Confidence |
|---|---|---:|---:|---|---|---|
| 1 | Bot block moves to the system prompt (in progress, `01a1a173`) | $121 | $121 | In progress | Low. Bots must Read context files they used to receive | Medium. Upper bound $266 before the offset explained in §5 |
| 2 | Lower Claude auto-compact from 400k to 280k (fires at about 250k) | $392 | $389 | Setting | Medium. About 2× the compactions, each a ~60 s pause and a summary | Medium. Backed by the 1–3 Nov natural experiment |
| 3 | Compact bot homes after 50 idle minutes when context ≥150k | $156 | $86 | Medium (daemon timer on the existing `/compact` path) | Low to medium. Summary replaces detail before the next message | Medium |
| 4 | Cap Bash output at 10k chars (`BASH_MAX_OUTPUT_LENGTH`) | $84 | $71 | Small (spawn env) | Low to medium. Agents may re-run commands | Medium to low. Re-run rate unknown |
| 5 | Remove 6k tokens from every session start and post-compact context: skill list, instructions, tool name lists | $64 | $75 | Medium | Low | Medium |
| | **Subtotal, fixes 1–5** | | **$742 (21%)** | | | |
| 6 | Route a quarter of Opus child spend to Sonnet | $205 | about $160 | Small to medium (routing defaults) | Medium. Quality and call count unknown | Low. The 25% is an assumption |
| 7 | Start a fresh thread instead of messaging a cold child | $28 | about $15 | Small (bot guidance) | Low | Low |
| 8 | Tighter defaults on FalconDeck's own tools | $20 | about $20 | Small | Low | Low |
| 9 | 5-minute cache on one-shot automation runs | $27 | about $25 | Small | Low. A run that pauses over 5 min pays a rebuild | Low. Ceiling chosen with hindsight |

**If only one ships, make it fix 2.** It is a setting and the largest single saving. Fixes 1 and 2 are roughly additive: $510/week together.

**Rejected:**

- **5-minute cache everywhere:** loses about $793/week. It would turn 1,135 warm reuses at 5–60 minute gaps into rebuilds. The 1-hour TTL is right.
- **Keep-warm pings:** the sums are close to fix 3 on homes ($176/week vs $156), but each ping is a real CLI turn, the context stays large, and it loses money on threads that stay quiet for long (§2).

## 1. Every cost source, by weekly cost

Measured weekly total: **$3,467** (reads $1,443, writes $1,344, output $679). Hit rate alone hides the mix: at 97.6% hit, reads still cost more than writes.

**A correction first.** A cache write is 40× a cached read on Opus and Sonnet, not 20×. A regression against reported cost fits read = 0.05× input ($0.20/M on Opus 5.5, $0.10/M on Sonnet 5.5) and 1-hour write = 2× input ($8/M, $4/M). Fit ratio 1.0.

These rows overlap and are gross. "Avoidable" is what a fix could plausibly remove.

| Source | Gross /wk | Avoidable /wk | Method | Confidence |
|---|---:|---:|---|---|
| Opus price on spawned children ($1,637/wk spend; half is the premium over Sonnet) | $818 | $160–205 | Analytics by origin and model | Low |
| Reads while context is ≥200k (11,048 calls) | $875 | $390 | Transcript read cost by context band; threshold replay | Medium |
| Bash output carried in context (24.6M tokens) | $773 | $70–160 | Write once plus read on each later call until compaction | Medium |
| Incremental writes from all other growth | about $400 | Low | Remainder of incremental writes | Medium |
| Idle rebuilds over 60 min (186 events, 33.3M tokens) | $335 | $86–240 | Call classified by gap and cache miss | High on size |
| Bot block | $266 | $121–266 | Per-turn chars from the closing tag position, same carry method | Medium |
| Thinking (31% of output tokens) | $213 | Low | Share of output, if billed as output | Medium |
| Skill listing | $153 | $50–80 | Carry; 26k chars, 665 injections | Medium |
| Compaction | $138 | Negative (fix 2 adds some) | $68 rebuild plus about $70 hidden calls | Medium |
| Instructions (AGENTS.md, CLAUDE.md, memory index) | $125 | $30–50 | Carry; 16k chars avg | Medium |
| System prompt and always-loaded tools (14.7k tokens) | $125 | $14 is FalconDeck's text | Read at first-call cached size on every call | High |
| Session starts (480, overlaps skills and instructions) | $122 | In fix 5 | Write cost on first call | High |
| Bash sandbox instructions | $63 | Up to $63 | Carry; 7.7k chars | Medium |
| Sub-agents | $60 | Low | Transcripts | High |
| Deferred tool and agent name lists | $56 | $20–30 | Carry | Medium |
| FalconDeck tool results | $39 | $20 | Carry | Medium |
| Automation-triggered rebuilds (inside idle rebuilds) | $37 | Low | Subset of the idle table | High |
| 1-hour write premium on one-shot automations | $27 | $25 | 225 of 315 runs had no gap over 5 min | Medium |
| Warm misses and model switches (14 events) | $22 | Low | Call classifier | High |
| Per-turn reminders, dates, hooks | under $10 | None worth doing | Carry | Medium |

Output is $679/week. $502 of that is spawned children, mostly real work: calls over 4k output are 21% of output tokens. I found no output waste to rank above.

### Reconciling the earlier figures

- **"306 turns writing over 100k make 68M of 124M" reproduces exactly**, with Juno at 22.1M. But those 306 turns contain 14,268 API calls, so they are mainly long turns, not rebuilds. True idle rebuilds are 186 calls and 33.3M tokens. The larger share of writes, 70.5M, is ordinary incremental growth.
- **"Home threads sit around 290k" doesn't hold across the window.** The per-call mean is 198k, and 224k weighted by cost. The 290k figure fits individual rebuilds, not the average.
- **Prefix stability still holds.** Unexplained warm misses are 10 events worth $9.3 in the window.

## 2. Idle-gap rebuilds

$196.4 in the window ($335/week), mean 179k tokens, median gap 161 minutes.

| Gap | Events | Cost |
|---|---:|---:|
| 1–1.25 h | 28 | $27.5 |
| 1.25–2 h | 50 | $61.5 |
| 2–4 h | 45 | $41.8 |
| 4–8 h | 20 | $23.6 |
| 8–12 h | 11 | $13.3 |
| 12–24 h | 24 | $20.7 |
| over 24 h | 8 | $7.9 |

| Who and what triggered it | Events | Cost |
|---|---:|---:|
| Bot home, non-automation message | 97 | $110.8 |
| Spawned child, message from another thread | 32 | $40.9 |
| User task, automation | 31 | $15.1 |
| Spawned child, non-automation message | 7 | $10.4 |
| User task, thread message | 6 | $8.3 |
| Bot home, automation | 6 | $6.3 |
| User task, non-automation message | 5 | $4.1 |

- **By bot:** FalconDeck Dev $38.5, no bot $33.2, Moneta $29.9 (only 15 events, 248k average), Juno $28.4, Vulcan $24.8, Iris $15, Libra $14.4, Mercury $12.1.
- **By model:** Opus $145.9, Sonnet $47.5, Haiku $2.9.
- **Automations are not the main cause.** They trigger 37 events worth $21.4, or 11%. The cadence guard already merged covers that part. Non-automation turns on homes are 56%, so cadence changes can't fix this.

### Options, alone, per week

| Option | Saves | Notes |
|---|---:|---|
| Compact at 50 min, all threads ≥100k | $266 | 137 compactions never see a return |
| Compact at 50 min, all threads ≥150k | $238 | 77 returned, 99 did not |
| Compact at 50 min, all threads ≥200k | $203 | 62 returned, 58 did not |
| Compact at 50 min, homes and user tasks ≥150k | $182 | 53 returned, 11 did not |
| **Compact at 50 min, homes ≥150k** | **$156** | 44 returned, 1 did not. Recommended start |
| Fresh session on return after 2 h | $192 | No compaction call, but thread memory is gone |
| Fresh session on return after 8 h | $103 | Bots can rely on STATUS and MEMORY; user tasks can't |
| Keep-warm, homes, stop after 2 / 4 / 12 / 24 h | $101 / $146 / $176 / $187 | Every ping is a CLI turn |
| Keep-warm, all threads, stop after 4 / 8 / 12 / 24 h | $158 / $132 / $84 / −$45 | Loses money on threads that stay quiet |
| Shorter automation cadence | Under $36 | The cost is not there |

### Does compacting before going quiet pay?

Opus, with a summary of 10k output tokens and a return that writes 54k. Sonnet gives the same break-even because every price halves.

| Context | Rebuild on return | Compact, then return | Saved if it returns | Lost if it never does | Pays above return rate |
|---|---:|---:|---:|---:|---:|
| 100k | $0.80 | $0.65 | $0.15 | $0.22 | 59% |
| 150k | $1.20 | $0.66 | $0.54 | $0.23 | 30% |
| 290k | $2.32 | $0.69 | $1.63 | $0.26 | 14% |

Bot homes nearly always return, so they clear this bar easily. That is why fix 3 starts there.

A keep-warm ping at 290k costs $0.06, and 38 pings (35 hours) equal one rebuild. That looks cheap, but pings are paid for every quiet hour on every thread. The ping must also be a real CLI turn, because `max_tokens: 0` pre-warming is API-only. It would add a line to history and would have to skip bot-block injection.

### Claude Code's idle compaction won't do this for us

Claude Code has this feature: `idleCompaction`, on by default, at 200k. It fires at 54 minutes (90% of the TTL). None of the 155 compactions in the window were idle ones, for two reasons:

- FalconDeck retires the warm CLI after 5 minutes (`WARM_IDLE_GRACE`, `crates/falcondeck-daemon/src/claude.rs:219`), so no process is alive at 54 minutes.
- The docs list only interactive terminal, VS Code and desktop-app sessions. The binary does have an `sdk` path, but keeping processes alive for an hour on that hope isn't worth it.

So FalconDeck should drive it: a timer at about 50 minutes calling the existing `/compact` path (`app/provider_runtime.rs:617`), only when the cache is still warm. Compacting after expiry is the worst case, because the docs confirm it reprocesses history uncached. A machine asleep at minute 50 should skip.

## 3. Compaction

**Is it failing to happen? No.** All 155 were automatic, the largest pre-compaction size was 382k, and no call exceeded 400k. No manual or idle compaction happened in the window.

The real issue is the threshold and what happens around it.

| Measure | Value |
|---|---|
| Compactions in window (151 inside exact bounds) | 155, about 38/day |
| Spawned child / bot home / user task | 71 / 66 / 13 (one unmapped) |
| Trigger size | p50 368k. Every setting fires about 30k early: 200k at 170k, 400k at 368k, 1M at 968k |
| Reported size after | p50 19k tokens (summary text p50 17k chars) |
| Actual context after | about 54k (39k written, 14.7k cached) |
| Duration | p50 63 s, p90 88 s, 2.7 hours total |
| Rebuild, visible in transcripts | $39.6, $0.26 each |
| Summary call, hidden from transcripts | about $0.31 on Opus (read about 360k, output about 11k). About $41 total, estimated |

**Each Opus compaction costs about $0.62** and frees about 314k, saving $0.063 per later call. It pays back in **10 calls**. Median calls to the next compaction or the end of data: 82. Only 11 of 151 ended under 10 calls.

**Rework is too small to see.** Across 116 compactions with 40 calls either side, context growth was 121k before and 116k after. Read-tool volume didn't rise. Re-reads of already-read files went from 14.5% to 17.6%, about one extra file per compaction. This cannot measure lost understanding.

**Rebuild, then compact, is a small leak.** 19 compactions came within 20 calls of a rebuild, paying $35.8 for context that was thrown away shortly after. Fix 3 removes most of this.

### Threshold

Natural experiment, same bots but a different work mix, so directional only:

| Era | Compactions | Calls | $/call | Mean context | Cost excl. output, per call |
|---|---|---:|---:|---:|---:|
| 1M window (22–31 Oct) | fires near 968k | 27,072 | $0.107 | 317k | $0.095 |
| 200k (1 Nov midday to 2 Nov) | 132 on 2 Nov | 11,108 | $0.060 | 126k | $0.050 |
| 400k (4–7 Nov) | about 40/day | 27,460 | $0.068 | 173k | $0.054 |

Replay per week against the current setting. "Rework" adds tokens written after each compaction; the measured value is close to the first column.

| Setting | Fires at | Compactions in window | No rework | 10k rework | 30k rework |
|---:|---:|---:|---:|---:|---:|
| 330k | 300k | 189 | $241 | $164 | $70 |
| **280k** | **250k** | **258** | **$387** | **$319** | **$162** |
| 230k | 200k | 373 | $508 | $397 | $172 |
| 200k | 170k | 484 | $551 | $408 | $86 |
| 180k | 150k | 613 | $534 | $364 | −$92 |
| 150k | 120k | 947 | $410 | $112 | −$943 |

At a 200k setting the replay gives 484 compactions in 4.1 days, or 118/day. The 132 actually seen on 2 Nov is close, which is a good check on the model.

**Recommendation:** set 280k and watch a week. 230k saves more but compaction count rises by nearly half again, and the 200k setting was tried on 1–2 Nov and left for reasons the data doesn't show. That choice should be James's, since quality is the part I can't measure. Below a 180k setting, compaction overhead takes over. These rows are from the threshold-only run, so 280k shows $387 here and $392 in the combined replay.

Codex uses the same 400k setting: 18 compactions, and 54% of its input tokens were sent at contexts ≥200k.

## 4. Long tasks and tool results

Spend is concentrated: of 495 threads, the top 10 are 33%, top 20 are 47%, top 100 are 87%.

| Thread | Type | Cost | Calls | Compactions | Read / write / output |
|---|---|---:|---:|---:|---|
| Juno home | Bot home | $136.9 | 2,368 | 25 | $53 / $64 / $20 |
| Vulcan home | Bot home | $104.9 | 1,532 | 15 | $40 / $53 / $11 |
| FalconDeck Dev home | Bot home | $73.0 | 658 | 5 | $26 / $38 / $9 |
| `37a5efb7` | Dev child | $60.1 | 520 | 3 | $21 / $21 / $18 |
| `49773d00` | Dev child | $54.1 | 369 | 6 | $15 / $25 / $14 |
| Mercury home | Bot home | $53.7 | 578 | 6 | $22 / $23 / $9 |
| Moneta home | Bot home | $53.5 | 249 | 3 | $9 / $39 / $6 |
| `604072a7` | Juno child | $46.9 | 579 | 3 | $24 / $14 / $9 |

Moneta is the outlier at $0.215 per call, three times the typical home, because it is written mostly by rebuilds.

- **Opus children:** 108 threads. 17 over $20 cost $539.6 and 49 at $5–20 cost $520. Sonnet children cost $0.030 per call against $0.066, close to the 2× price gap, so Sonnet is not visibly needing more per call. That doesn't show the same tasks were comparable.
- **Effort is not a visible lever.** Opus $/call: medium $0.072, high $0.069, low $0.090. High adds 18% output per call, but context size swamps it. Mix differs by effort, so this is weak evidence.
- **Sub-agents** are 1.7% ($35.4 in window) and are not a problem.
- **Routing:** 243 route events in analytics, at least 60% automatic. Automatic routes often pick Opus or Sol. I didn't assess whether those picks were right.

### Tool results (Claude)

Bash is 84% of all tool-result characters. Measured 2.43 chars per token on large outputs, much denser than the usual 4.

| Tool | Results | Chars | p50 | p95 | Max | Carry /wk |
|---|---:|---:|---:|---:|---:|---:|
| Bash | 25,488 | 59.9M | 771 | 10,388 | 30,000 | $773 |
| Read (understated, see Limits) | 2,668 | 6.6M | 1 | 16,425 | 86,611 | $71 |
| `falcondeck_search` | 54 | 0.66M | 4,200 | 29,423 | 29,423 | $11 |
| `falcondeck_list_threads` | 200 | 0.53M | 1,561 | 10,121 | 23,990 | $7 |
| `falcondeck_get` | 90 | 0.44M | 2,239 | 15,501 | 43,039 | $7 |
| `falcondeck_execute` | 91 | 0.26M | 2,120 | 10,061 | 11,192 | $4 |
| `falcondeck_view_thread` | 115 | 0.26M | 1,632 | 5,812 | 8,282 | $3 |
| `falcondeck_thread_summary` | 131 | 0.24M | 1,052 | 5,855 | 8,603 | $3 |
| `falcondeck_message_thread` | 1,547 | 0.26M | 171 | 171 | 1,450 | $3 |

- **Bash:** results over 10k are 5% of calls but 37% of chars (22.2M). Caps, alone: 20k $13, 15k $36, 10k $84, 5k $163/week. FalconDeck sets no Bash limit today.
- **FalconDeck's tools are real but small:** 2,825 calls, 2.8M chars, $39/week. `falcondeck_get` with no fields didn't reach 170k in this window; the largest was 43k on Claude and 46k on Codex, possibly the `MAX_MCP_OUTPUT_TOKENS=25000` cap, though I didn't confirm that. So I'd fix defaults, but this isn't a top item. Worth it mainly for `falcondeck_search`, whose p50 on Codex is 28.8k.
- **On Codex, results look larger:** `list_threads` p50 35k, `search` 29k, `get` 12k. These come from `exec` calls that can bundle several tools, so treat them as upper bounds.
- **Handoff blocks barely registered.** Non-bot context blocks were 21 turns of 414 chars. Handoff text may sit in other turns I couldn't separate, but it isn't large.

## 5. Everything injected

### Claude: start of session and per turn

A fresh thread starts at about 44k tokens: 14.7k cached system and tools, 29k written.

| Item | Avg chars | Times | Carry /wk | Whose | Note |
|---|---:|---:|---:|---|---|
| Bot block | 25,400 per turn | 1,516 | $266 | FalconDeck | Per turn |
| Skill listing | 26,100 | 665 | $153 | User, via plugins | Session start and post-compact |
| Instructions | 16,200 | 749 | $125 | User | 29k chars in FalconDeck children |
| System and 11 tools | 43,000 | every call | $125 | Claude Code; FalconDeck about 5k | Shared cache across sessions, so the first call reads it |
| Sandbox instructions | 7,700 | 1,009 | $63 | Claude Code | From `sandbox.enabled` in user settings; seen on bot and automation sessions |
| Deferred tool names | 5,800 | 756 | $38 | MCP servers | Ableton, Sentry and others in every session |
| Agent listing | 2,800 | 682 | $18 | Claude Code | |
| Environment | 400 | 3,222 | $13 | Claude Code | |
| Session context | 1,100 | 704 | $7 | Claude Code | |
| Nested memory | 1,600 | 278 | $7 | User | |
| Turn reminder | 155 | 2,025 | $3 | Claude Code | |
| Hooks (all types) | small | 138 | about $1 | FalconDeck | Fine as is |
| Date, model, token reminders | small | about 2,000 | about $3 | Claude Code | Fine as is |

Queued messages ($53/week) are content, not overhead.

### Sizing the bot block work

This is much bigger than the 3.5–6k tokens I reported on 3 Nov. p50 is now 25,400 chars, about 9k tokens, sent on 1,272 home turns. In the latest turn, Juno, Vulcan, Iris, Libra and Moneta were at 28–32k chars, Mercury 12k and FalconDeck Dev 9k. The difference is mostly context file bodies; the fixed sections are about 5k. It is **51% of all incremental context growth on home threads** (9.8M of 19.3M tokens).

The gross cost is $266/week, but the replay gives only $121. The reason matters: with a fixed ceiling, removing the block means compactions fall from 133 to 102 and context stays high for longer, so much of the read cost returns. Context filled by other work takes the block's place. Expect a real but smaller saving than the block's size suggests. Adding fix 2 gives $510 together, about the sum of the two.

From the in-progress diff, only stable text goes into the system prompt, and file bodies stay out, so a STATUS or MEMORY edit won't break the cache. That's the right design. An edit to a bot's instructions will rebuild once, which is fine. The Codex note in that thread (app-server ignores `developerInstructions` on a loaded thread) is a real path to test.

The analytics work surfaces waste but saves nothing directly. It would be most useful showing rebuilds per thread and compaction counts, to measure these fixes.

### Codex

First request p50: 28.7k tokens, 13.2k of it already cached.

| Item | Chars |
|---|---:|
| `additional_tools` | 43,700 |
| of which `exec` | 29,129 (web tool 11k, ologs 5k, image 2.6k) |
| Skills | 40,260 |
| Base instructions | 21,524 |
| FalconDeck text | 4,985 |
| Deferred namespace list | 4,096 |
| Multi-agent and collaboration text | about 3,700 |

**The 14 extension tools don't look fully loaded on Codex.** They are absent from `additional_tools` in all 61 sessions sampled, and absent from the `exec` description. Only the namespace line is present. Agents reach them through `exec`. The first-request size has no room for them either. I can't exclude definitions loaded later without being recorded.

The bigger Codex item is **skills at 40k chars**, which is 50% larger than Claude's list and sits in every request.

### Grok and OpenCode

First-turn input is about 49k tokens per call on Grok and about 119k on OpenCode. OpenCode is only 4 threads, and I didn't break either down. Grok is about $83/week in total.

## 6. Claude Code vs what we control, and other providers

| Controlled by | Items |
|---|---|
| FalconDeck | Bot block, auto-compact point, warm-process grace, timed compaction, Bash cap, FalconDeck tool sizes and text, routing defaults, TTL env per spawn |
| User settings and files | Plugins and skill list, MCP servers, CLAUDE.md, AGENTS.md, memory index, sandbox setting |
| Claude Code only | System prompt, tool text, 1-hour default, cache breakpoints, compaction prompt, reminders, thinking on current models |
| API-only, out of reach while on the CLI | `max_tokens: 0` pre-warm, context editing, per-message effort, server compaction |

Names read from the binary such as `CLAUDE_CODE_IDLE_COMPACT_MIN_TOKENS` may be undocumented and can change. `CLAUDE_CODE_PROMPT_CACHE_TTL` and `idleCompaction` are documented.

### Hit rates

Cached share of all input tokens. The formula is comparable; the economics are not.

| Model | Input uncached | Cached | Written | Hit |
|---|---:|---:|---:|---:|
| gpt-6.1-sol | 24.0M | 1,849M | 0 reported | 98.7% |
| claude-opus-5-5 | 1.1M | 3,460M | 73.6M | 97.9% |
| claude-sonnet-5-5 | 1.0M | 1,408M | 45.1M | 96.8% |
| grok-4.7-build | 4.2M | 60.7M | 0 reported | 93.5% |
| claude-haiku-5-5 | 1.9M | 79.7M | 5.5M | 91.5% |
| glm-5.3 | 2.3M | 23.5M | 0 reported | 91.3% |
| gpt-6.1-terra | 0.6M | 4.2M | 0 reported | 87.5% |
| grok-4.7-build-fast | 9.0M | 55.8M | 0 reported | 86.2% |

### Why no writes?

- **Codex: this may not mean free.** `cache_write_input_tokens` is 0 in all 58,855 records, but OpenAI's docs say GPT-5.6 and later charge writes at 1.25× input for the default 30-minute life, or 2.5× for 12 hours. Either the Codex backend doesn't report writes or the subscription route handles them differently. I can't tell which. The `in` figure may include written tokens.
- **Grok:** xAI's docs describe only uncached and cached rates and no write fee.
- **OpenCode (GLM):** caching is implicit, and I couldn't verify a write rate from primary docs.

OpenAI's docs put Sol reads at 0.05× input, so the Claude lesson probably applies. 1,849M cached is about 92M input-equivalents, against 24–30M uncached. Reads are about 75–80% of input-side cost, so context size is the lever on Codex too. This is before output, and no price was verified.

**Codex misses in the window:** 44 of 11,247 calls at under 5 minutes, 14 of 95 at 5–60 minutes, 3 of 19 at 1–4 hours, 6 of 8 at 4–24 hours. Those misses are 7.0M of 25.6M uncached tokens. Samples above 5 minutes are small.

Grok's lower hit rate is mostly short threads: 73 threads, 159 turns, one at $22.3. It isn't worth tuning at about $83/week, though I didn't check whether the Grok CLI sets `x-grok-conv-id`, which xAI recommends.

## 7. Outside guidance we don't follow

- **Anthropic: compact at natural breaks.** `/usage` even recommends "Compact before you step away". Fix 3 does this.
- **Anthropic: clear between unrelated tasks.** Bot homes run everything through one thread.
- **Anthropic: Sonnet for most coding, Opus for complex decisions; Sonnet for teammates.** We default children to Opus (fix 6).
- **Anthropic: filter verbose output with hooks.** For example, pipe test runs to failures only. A stronger version of fix 4.
- **Anthropic: CLAUDE.md under 200 lines, specialist instructions in skills, disable unused MCP servers.** Fix 5.
- **Anthropic: custom compaction instructions.** Unused, and cheap to try. It could reduce the quality risk of fix 2.
- **Aider: keep-alive pings.** Built for the 5-minute cache. Rejected at 1 hour (§2).
- **OpenAI: longer cache lifetimes.** A 12-hour option exists at 2.5× write. I found no way to set it through Codex, and didn't look further.

I did not review Cline, Cursor or OpenCode's own guidance.

Sources: [Claude Code costs](https://code.claude.com/docs/en/costs), [Claude Code prompt caching](https://code.claude.com/docs/en/prompt-caching.md), [Claude Code settings](https://code.claude.com/docs/en/settings-reference.md), [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching.md), [xAI prompt caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/usage-and-pricing), [aider caching](https://aider.chat/docs/usage/caching.html).

## Corrections to my 3 Nov report

The verdict holds: no systematic prefix break. These statements were wrong, unsupported, or left out:

1. **Pricing.** I used reads at 0.1× and write-to-read of 20×. It is 0.05× and 40× on Opus and Sonnet. The "1.9N" waste sums and ping costs were wrong.
2. **In-process losses, omitted.** Before 19 Oct there were about 17.3M tokens of losses (19.16M total vs 1.83M after), plus 7.5M of unexplained large misses from 13–17 Oct. I left these out of the headline "about 1%". The 3.0M loss since 19 Oct was also compared against a read total from a longer window.
3. **Codex prefix stability was stated flatly but only inferred.** My small sample pointed the other way: at 5–60 minutes, new process 38% miss (n=16) vs same process 11% (n=18). I described that as too little to separate. It should read **not proven**. Logs from then are gone, so I could not re-test it.
4. **"OpenAI eviction"** was inference, not measurement.
5. **"47% after over 1 h, 7% after over 12 h"** mixed populations: the 7% came from a different table.
6. **"All 47 warm misses are explained"** wasn't verified. 8 were not individually explained, and compaction was assumed for others.
7. **"About 79M sub-agent"** counted all uncached sub-agent tokens, not only misses, and mixed bases.
8. **All 19 home model switches were blamed on automations** without checking each. Some were human turns. The fix is merged anyway.
9. **Stale numbers.** The bot context of 3.5–6k tokens and compaction at 166k are out of date.

## Limits: what I could not measure

- **Real money.** All figures are list-equivalent. On a subscription, the benefit is limit headroom.
- **Quality.** Nothing here measures whether agents do worse after compaction, truncation, Sonnet routing or not seeing context files. That is the main risk in fixes 1, 2, 4 and 6.
- **A short window.** 4.1 days, weekly by ×1.708, with the 400k setting in place only since about 3 Nov. The workload may not be typical.
- **Hidden calls.** Compaction summaries aren't in transcripts. $0.31 is inferred from analytics-minus-transcript on clean single-compaction threads. Whole-window deltas are unusable because interrupted turns are missing from analytics.
- **Analytics vs transcripts.** They agree within 1–3% overall, but analytics shows far more uncached input (Opus 1.1M vs 42k, Haiku 1.85M vs 1.2k). Probably side calls. Unexplained.
- **Read tool volume.** Median Read result is 1 char in transcripts, so most bodies seem not to be stored. Read volume is understated. Bash isn't affected.
- **Replay assumptions.** Growth continues unchanged after a fix; post-compact context is 54k; summaries are 10k output. Replay runs about 3% above measured cost. Keep-warm figures come from a separate, simpler run and aren't additive with the combined table.
- **"Non-automation" turns in §2** have no automation or thread-message marker. Some may be daemon-delivered results rather than James's own messages.
- **Bash cap behaviour.** Over-limit output seems recoverable from a saved file, as seen in this session, but I didn't test the env var or how often agents re-run.
- **Idle compaction under stream-json.** Not run, per the brief. Docs say it isn't supported in this mode; the binary has an `sdk` path.
- **Chars to tokens.** 2.43 is measured for tool output, 2.8 assumed for injected text (session starts fit 2.6–3.0). Carry figures scale with this.
- **Codex.** Unpriced, write tokens unreported, and only rollout data.

## Method

- **Sources:** `~/.falcondeck/analytics/usage-2026-11.jsonl` (3,851 records), Claude transcripts (113,478 unique calls, of which the window's are used), 107 Codex rollouts, `events-*.jsonl`, daemon state and prefs. Only sizes, names and hashes were extracted. No session content is quoted.
- **Pricing:** per-call regression on reported cost. Opus 5.5 $4 / $0.20 / $8 / $20 (input, read, 1-hour write, output). Sonnet 5.5 $2 / $0.10 / $4 / $10. Haiku 5.5 $0.10 / $0.01 / $0.20 / $0.50, ×5 over 100k prompt.
- **Rebuild:** cached read under half the previous context, previous context over 20k, gap of at least 60 minutes.
- **Carry cost:** tokens × write price once, plus read price on each later call until compaction or end, plus write price on rebuilds.
- **Replay:** per-session walk over real calls using actual growth and output. Fixes change growth, ceiling or rebuild behaviour. Combined runs are what make the "In order" column safe to sum.

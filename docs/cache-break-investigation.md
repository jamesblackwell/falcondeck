# Prompt-cache break investigation (Claude Code + Codex)

Date: 3 Nov 2026. Read-only investigation; no code changed.

## Verdict

**No. FalconDeck does not systematically change the cached prefix between turns of a reused thread.**
The bot context, handoff context, upkeep notes, STATUS/MEMORY reminders, the "Projects, most recently
active first" list, the other-bots list and automation digests are all prepended to the *new user
message*, after the cached prefix. The Claude system prompt and tool list are byte-identical across
warm turns, including across the 5-minute idle respawns (`--resume`). The Codex prefix is likewise
stable across app-server retirement and `thread/resume`.

Where the cost actually goes:

| Cause | Claude cache-write tokens | Codex uncached tokens | FalconDeck can fix? |
|---|---|---|---|
| Cache expired: Claude 1 h TTL, Codex/OpenAI eviction | 150.4 M (51% of all Claude writes) | ~52 M after >60 min gaps; ~79 M on 5–60 min **sub-agent** wakeups | Only by keeping the cache warm |
| **Home-thread automations pin a different model** | 2.1 M (19 switches) | — | **Yes** (cause 1) |
| User or auto-routing model/effort switch mid-thread | 4.8 M (9) | ~4.3 M (31 turns) | Partly (cause 2) |
| Auto-compaction (Claude Code rewrites the history) | 7.8 M (201) | — | Setting (cause 4) |
| Prefix changed on a warm respawn (FalconDeck build or setting change) | ≤ 0.8 M | not separable | Minor (cause 3) |

That makes FalconDeck-attributable prefix breaks about **1% of Claude cache writes**. The big
number is TTL expiry, which is not a break.

## Measured tables

### Claude (FalconDeck `sdk-cli` sessions, 7 Oct – 3 Nov, main chain, deduped on `message.id`)

First API call of each user turn, bucketed by the gap since the session's previous call:

| Gap | Turns | Cache-read share | Turns with a large miss (cc > 20k and > 50% of the previous context) |
|---|---|---|---|
| < 5 min | 2,789 | **98.5%** | 29 (1.0%) |
| 5–60 min | 1,398 | **97.5%** | 18 (1.3%) |
| > 60 min | 413 | 2.4% | 400 (97%) |

The edge at 60 minutes is sharp, which is the 1 h TTL rather than a prefix change:

| Gap (min) | 50–55 | 55–60 | 60–65 | 65–70 | 70–75 |
|---|---|---|---|---|---|
| Read share | 98% | 97% | 6% | 3% | 2% |

All 47 warm "large misses" are explained by one of:
- model switch: 23
- the first call after an interrupted turn (synthetic previous message): 16
- auto-compaction
- one session (`c3a6c575`, 21 Oct) with an unexplained in-process miss of 680–800k tokens.

Across **every** API call since 19 Oct, excluding compaction, model switches and gaps over 60 min,
the tokens lost against the previous call's prefix total **≈ 3.0 M**, against 19.5 B tokens read:

| Path | Calls | Lost tokens |
|---|---|---|
| Same process, same system+tools | 44,996 | 1.83 M (mostly 2 sessions) |
| Same process, tool set changed (deferred tools loaded) | 614 | 0.36 M (tool changes do not break the cache) |
| **Respawn (`keep=0`, `--resume`)**, same shape | 1,012 | 0.81 M (one 683k event) |
| Respawn, system or tools changed | 19 | 36 |

Where the misses fall, by thread type (cache-write tokens):

| | TTL > 60 min | Model switch | Compaction |
|---|---|---|---|
| Ordinary tasks | 91.2 M (233) | 4.8 M (9) | 4.7 M (105) |
| Bot home threads | 30.2 M (96) | 2.1 M (19) | 2.7 M (88) |
| Automation runs | 29.0 M (72) | 0.1 M (1) | 0.3 M (8) |

Of the TTL misses, 57 (18 M) fell just past the edge, at 60–75 min.

### Codex (FalconDeck `originator=falcondeck` rollouts, 1 Oct – 3 Nov, first request per turn, input ≥ 20k)

The background table's 71% at 5–60 min mixes two very different populations:

| Turn trigger | < 5 min | 5–60 min | > 60 min |
|---|---|---|---|
| **FalconDeck-sent top-level turn** (user, automation, message_thread) | 94% hit, 7% miss turns (388) | **85%** hit, 15% miss (246) | 47% hit (271) |
| **Codex `spawn_agent` child woken by parent** (`inter_agent_communication_metadata`) | 97% hit (524) | **67%** hit, 38% miss (966) | 39% hit (154) |

- Sub-agent wakeups account for 366 of the 433 misses at 5–60 min, and about 79 M of the 88 M uncached tokens.
- They run inside a live app-server (the parent turn holds it, so no idle retirement).
- The rollout shows nothing new before the miss beyond `task_started` and `turn_context`; hits show the same pattern.

This is server-side eviction. The miss rate climbs smoothly with the gap: about 3% below 4 min, then
16–28% at 5–8 min and 40–55% at 8–10 and 40–50 min. Only the tools and base-instructions block
(about 13k tokens) stays cached, which looks like a shared cross-session prefix.

Turns whose `turn_context` changed (model, effort or collaboration mode) miss far more often within 5 min:
- unchanged: 3% (30 of 889)
- collaboration mode only: 39% (12 of 31)
- effort change: 6 of 9
- model change: 2 of 2

## Causes, with code and proposals

### 1. Home-thread automations switch the bot's model (Claude, FalconDeck-caused, ~0.7% of writes, highest cost per event)
`crates/falcondeck-daemon/src/control/scheduler.rs:467` sends `model_id: automation.target.model_id`
on a turn into the existing (home/current) thread. Fresh runs inherit the home model
(`scheduler.rs:278`), but a pinned model wins. Examples:
- "Atlas: exec check-in (3x daily)" pinned to Haiku
- "Libra: refresh QuizGecko metrics" pinned to Sonnet
- "Moneta daily spend" pinned to Haiku

Each run rewrites the whole 60–170k home context on the cheaper model, then the next human turn on
Opus rewrites it again. Evidence:
- Vulcan `3db03e54`: Opus→Haiku at 07:00 and 19:00, then back to Opus, 115–160k written each time.
- Libra `a965cfe0`: six switches in one day.

**Fix:** when an automation targets an existing thread (`current`/home), ignore `target.model_id`
and `reasoning_effort` and use the thread's own, or reject the combination at save time. If cheap
runs are the goal, run them as fresh threads with a bot digest (the `run_as_bot` path), not in the home thread.

### 2. Mid-thread model/effort changes (Claude + Codex, user/auto-routing driven)
A model change is always a full miss: the cache is per model. FalconDeck respawns Claude with a new
`--model` (`claude.rs:428`), and Codex gets `model`/`effort` on `turn/start` (`codex.rs:333-334`,
`provider_runtime.rs:347`). Effort changes on Codex also correlated with misses (6 of 9).
- 9 Claude task switches cost 4.8 M; 31 Codex turns cost ~4.3 M.

**Fix:** in the composer, warn when changing the model on a thread whose context is over ~50k
("re-reads N tokens uncached"). Keep auto-routing to new-thread briefs only, as it is today
(`app/routing.rs`). Do not let routing re-pick the model on follow-up turns.

### 3. Prefix changes on respawn (Claude; minor, only across builds or settings changes)
Each Claude turn after 5 min idle respawns with `--resume` (`WARM_IDLE_GRACE`, `claude.rs:216`). The
`api-request-shape` diff across respawns was empty in 1,012 of 1,031 warm cases. The 107 respawns
that did change shape were almost all after a > 60 min gap. What changed:
- `--append-system-prompt` text (`agent_context.rs:211-260`) after a FalconDeck rebuild, or after the
  computer-use backend setting changed (cua-driver ↔ agent-desktop).
- The `falcondeck_suggest_follow_ups` line (`agent_context.rs:224`). It is gated on
  `extensions.agent_tools()` (`app.rs:1374`), so it can drop out if extensions are not loaded yet
  when a turn spawns right after a daemon start.
- `falcondeck_create_thread` description, which embeds the `max_children` user setting
  (`app/thread_tools.rs:30`), plus tool-description rewrites in new builds (message_thread,
  falcondeck_get/execute).

Nothing in the prefix is time-, activity- or turn-dependent:
- no date, thread id, projects or bots list, or HashMap iteration;
- MCP servers are `BTreeMap`/ordered `Vec` (`connectors.rs:375-391`, `claude_mcp_config_json` at `connectors.rs:524`);
- extension tools are sorted (`app/extensions.rs:491`);
- Codex `-c mcp_servers.*` overrides come from the same ordered list (`codex.rs:740-760`).

**Fix (low priority):** compute `suggest_follow_ups` from the extension manifest, not from
load state, so a cold spawn produces the same prompt. Optionally move `max_children` out of the
tool description into the refusal message, which already states it.

### 4. Compaction (Claude Code behaviour, setting-driven)
201 auto-compactions wrote 7.8 M tokens. Bot home threads compact often: Juno compacts at about 166k
(`AUTOCOMPACT_ENV`, `claude.rs:430-438`), and one session has dropped 7.4 M tokens cumulatively.
Each bot turn appends about 3.5–6k tokens of bot context (median 14–17k chars; Juno 557 turns) to the
history (`app/workspace_ops.rs:3455`, `app/bots/context.rs:197-330`). This is cache-friendly, but it
fills the window and brings compaction forward.
**Fix (optional):** inject the full bot context only on the first turn after a compaction or
respawn, plus a short delta on later turns, or shrink it (projects list, peers list and document
inventory repeat every turn).

### 5. Cache expiry (not a break; the largest cost)
- Claude: 401 turns after > 60 min rewrote 150 M tokens. 57 of them (18 M) landed at 60–75 min.
- Codex: misses after 5–60 min are mostly sub-agent wakeups, which FalconDeck does not control.
- Logged-in Codex does **not** keep the cache "forever" in practice: 47% hit after > 1 h and 7% after > 12 h for top-level turns.

**Option:** a keep-warm ping for Claude bot home threads that are likely to be used within the next
hour. A ping reads the context at 0.1× instead of rewriting it at 2× later. Also schedule hourly
heartbeats at ≤ 55 min intervals rather than exactly 60.

## Claude Code's own contributions (outside FalconDeck's control)

- System block 1 is Claude Code's static prompt, cached with `scope: global` (about 11–15k tokens
  read even on full misses). Block 2 holds FalconDeck's append, the environment and the memory instructions.
- The date, environment, git status, skill and agent listings and `deferred_tools_delta` are sent
  as **message attachments**, not in the system prompt, so they do not break the prefix.
- Mid-session tool-set changes (deferred MCP tools loaded through ToolSearch) did not break the cache
  in 614 cases (`mid-conversation-tool-changes` beta).
- Claude Code upgrades change the system text and tool descriptions. Examples: "Write code that reads
  like the surrounding code", "Do build original games…", and Bash description rewrites.
- After `--resume`, 3 respawns re-materialized discovered deferred tools in a different order.

## Recommendations (ranked)

1. **Stop home-thread automations from switching model or effort** (`control/scheduler.rs:467`). This is the only systematic FalconDeck-caused break, and it fires on a schedule.
2. **Make model and effort switches on large threads deliberate**: show a cost warning, and never auto-route follow-up turns.
3. **Decide on keeping bot home threads warm** (a ping at about 55 min, or 50–55 min schedules). This is where most of the Claude money goes, and FalconDeck is the only place that can act on it.
4. **Trim the per-turn bot context** so home threads compact less often.
5. Make `--append-system-prompt` independent of extension load timing (`agent_context.rs:224`, `app.rs:1374`).
6. Update the background analysis: the Codex 5–60 min hit rate is 85% for FalconDeck-sent turns. The 71% figure is pulled down by Codex's own sub-agent wakeups.

## Method

- **Claude:** `~/.claude/projects/*/*.jsonl`, entrypoint `sdk-cli`, non-sidechain.
  - Claude Code 2.1.3xx writes `api-request` records (`shapeHash`, `keep`, `params`) and `api-request-shape` records (full system and tools) for every request since 18 Oct. Consecutive requests were diffed directly.
  - A respawn is `keep=0`. Compaction is a `compact_boundary` record. A miss is cache_read < 50% of the previous call's input.
- **Codex:** `~/.codex/sessions/2026/1[01]/*.jsonl`, `originator=falcondeck`.
  - Per-request usage comes from `token_usage_record`; turn starts from `task_started`.
  - `turn_context`, `world_state`, `additional_tools` and developer/user messages between requests were diffed.
  - Sub-agent threads were identified by `session_meta.source.subagent` and by `inter_agent_communication_metadata` before the turn.
  - Per-workspace Codex `logs_2.sqlite` (`process_uuid`) only holds about a day of logs, too little to separate respawns statistically.
- Code traced: `claude.rs` (spawn args), `agent_context.rs`, `app/workspace_ops.rs` (turn assembly), `app/bots/*`, `app/provider_runtime.rs` and `codex.rs` (Codex turn/start, resume), `connectors.rs`, `app/thread_tools.rs`, `control/scheduler.rs`, `app/runtime_health.rs`.
- No live or billed experiments were needed: the request-shape logs gave a direct diff.

The optional [stable bot context rollout](bot-system-context.md) moves standing
Claude/Codex bot guidance into native system/developer instructions. It prevents
new repeated bot blocks without editing existing provider history. Volatile
inventories and file contents stay outside the system prefix.

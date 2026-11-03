# Token usage and cost tracking: scoping report

Scope only; nothing is implemented. Written 3 Nov 2026 from the code at `main` (50ef995e), a live probe of the Claude CLI, and a scan of the transcripts on this Mac.

## Key findings

1. **FalconDeck does not record billable usage today.**
   - It keeps one *context-fill* number per thread (`thread_token_usage`, latest value, in memory only). It is not persisted, has no model or cost, and no desktop UI shows it since the Aug 10 removal (see §1).
   - The `analytics` module writes a per-turn record (`turn`: `i`, `out`, `ctx`). Only Codex fills `i`/`out`. In Oct 2026, 258 of 1,289 turn records have `i > 0`. Claude and ACP turns carry only a peak context size. No record has a model, cache split or cost.
2. **The data to do this properly is already flowing on every harness; we mostly drop it.**
   - Claude `result.modelUsage` has per-model tokens and `costUSD`.
   - Grok `turn_completed` has per-turn usage, per-model usage and cost.
   - The ACP `session/prompt` response has `usage`.
   - Codex `last_token_usage` gives per-request deltas.
   - OpenCode's SQLite has `cost` and `tokens` per message.
3. **Existing bug (Claude): `result.usage` is not a turn aggregate. It is the last API call only.** Verified by probe (§2). `threads.rs:~1850` feeds `result.usage` into `record_claude_run_usage`, so automation-run `input_tokens`/`cached_input_tokens` are under-reported for any turn with more than one model call. The comment on `live_context_usage` ("`result.usage` is a billed-turn aggregate") is wrong. The aggregate is `modelUsage`, which includes subagents.
4. **The spend James suspects is visible in the transcripts.**
   - Oct to Nov 2026, FalconDeck-spawned Claude (`entrypoint: sdk-cli`), unique API messages:
     - Opus 5.5: about 80.5k, roughly 24 B input-side tokens.
     - Sonnet 5.5: about 9.4k.
     - Haiku 5.5: about 0.5k.
   - **Subagents (`isSidechain`) run almost entirely on Opus 5.5: 13.5k messages vs 412 on Sonnet 5.5 and 0 on Haiku 5.5.** They inherit the parent model. Cheaper subagents are the obvious first saving.
   - Codex: `gpt-6.1-sol` dominates (about 11.7 B input tokens in Oct, 4.3 B in Nov 1-3), about 97% of it cache reads.
5. **History can be recovered for Claude, Codex, Grok and OpenCode (§4).** A first-pass scan of 4.9 GB of Claude transcripts and 12 GB of Codex rollouts takes seconds to a minute.
   - Attribution to FalconDeck threads works through `native_session_id`. Bot attribution works for threads that still exist.
   - Deleted threads fall back to project and cwd.
6. **Attribution is mostly there but has gaps** (§3). The main ones are one-hop bot ownership only, no per-turn model record, and live Codex sub-agent threads unverified.
7. **Quota and rate-limit visibility already exists** (Settings → Usage, `provider_usage.rs`). It covers Claude, Codex, Grok, Cursor, Antigravity, Z.AI and OpenRouter. It is not correlated with per-turn tokens.
8. **Recommended home:** extend `analytics` (same writer thread, JSONL files, retention and local-only API) with a `usage` record. It already has per-bot rollups with the `bot_of` parent walk, and a turn tracker.

## 1. Current state

| Area | What exists | Where |
| --- | --- | --- |
| Protocol | `TokenUsageBreakdown {total, input, cached_input, output, reasoning_output}`; `ThreadTokenUsage {total, last?, model_context_window?, updated_at?}`; `UnifiedEvent::ThreadTokenUsageUpdated`; `Snapshot.thread_token_usage` map | `crates/falcondeck-core/src/lib.rs:2263-2283, 1322, 5099`; TS mirror `packages/client-core/src/types.ts:1763-1774, 1474, 1880` |
| Daemon store | In-memory `thread_token_usage: HashMap<thread, ThreadTokenUsage>`. Latest value only; it is not persisted and is lost on restart. | `app.rs:351`, `app/threads.rs:1492-1510` |
| Codex source | `thread/tokenUsage/updated` parsed to `ThreadTokenUsage` | `app/notifications.rs:275-290, 2109, 2286` |
| Claude source | `message_start` / `message_delta` / assistant `usage` mapped to context fill (`input + cache_read + cache_creation`). `output_tokens` is kept but `cached_input_tokens` mixes read and creation. `result` supplies only `contextWindow`. | `claude/stream.rs:490-575`, `app/threads.rs:1860-1885` |
| ACP source | `usage_update {used, size}` becomes `total_tokens = used`, other fields 0. | `acp.rs:4549`, `app/acp_threads.rs:1400-1436` |
| Automation runs | Run records have `input_tokens`, `cached_input_tokens` (Option). Codex: delta of the thread cumulative total. Claude: `result.usage` (buggy, see finding 3). | `control/service.rs:1414, 1585-1625`, `control/scheduler.rs:435-545`, `core/control.rs:516` |
| Analytics | Local JSONL, `turn` record `{ok, ms, i, out, ctx}`. Per-bot (`AnalyticsBot.avg_context_tokens` is *injected context*, not usage) and per-provider (`input_tokens`, `output_tokens`, `avg_peak_context_tokens`) rollups. `bot_of(thread)` = bot home or a direct child. | `app/analytics.rs:340-390, 760-770, 920-1100`; `core/analytics.rs:180-215`; `docs/ANALYTICS.md` |
| Analytics UI | Settings → Analytics: bots table, providers table (input and output tokens, avg peak context) | `apps/desktop/src/components/settings/AnalyticsPanel.tsx:660-700` |
| Quota UI | Settings → Usage: per-provider subscription windows (% used, reset time), OpenRouter spend, Codex reset credits. 5-minute cache. | `app/provider_usage.rs`, `UsagePanel.tsx`, mac `Workspaces/ActivityUsage.swift` |
| Surviving UI for context | iOS native `TaskUsageView` in `TaskOptionsView.swift:103` reads `tokenUsage[task.id]`. Mac native only projects the map. Desktop merges it in `hosts.ts:1050` but renders nothing. | `ios-native-pilot/.../AppEvents.swift:61,149` |
| Removed | **9a78214c, 10 Aug 2026:** "this context indicator just is not accurate", removed on all surfaces. Deleted: `chat-ui/context-usage-indicator.tsx`, `mobile/.../ContextUsageIndicator.tsx`, `client-core/context-usage.ts`, plus the `tokenUsage` props. **The data path was kept** (snapshot and event). The inaccuracy was Claude context math (cumulative `result.usage`, ACP "used" vs window). | thread 9a78214c |

Not found anywhere: persisted per-turn usage, cost, model per turn, cache read and write split in storage, any price table, subscription cost settings.

## 2. What each harness gives us

### Claude Code (CLI subprocess, `--output-format stream-json`)

Probe run on 3 Nov 2026 (`claude -p ... --model haiku --output-format stream-json --verbose`, claude-haiku-5-5). Trimmed `result` line:

```json
{"type":"result","subtype":"success","num_turns":1,"duration_ms":2698,"duration_api_ms":2534,
 "total_cost_usd":0.00391086,
 "usage":{"input_tokens":2,"cache_creation_input_tokens":18949,"cache_read_input_tokens":11886,"output_tokens":4,
          "output_tokens_details":{"thinking_tokens":0},
          "cache_creation":{"ephemeral_1h_input_tokens":18949,"ephemeral_5m_input_tokens":0},
          "service_tier":"standard","speed":"standard"},
 "modelUsage":{"claude-haiku-5-5":{"inputTokens":2,"outputTokens":4,"cacheReadInputTokens":11886,
     "cacheCreationInputTokens":18949,"costUSD":0.00391086,"contextWindow":1000000,"maxOutputTokens":128000,
     "thinkingTokens":0,"cacheCreationEphemeral1hInputTokens":18949,"canonicalModel":"claude-haiku-5-5",
     "provider":"firstParty","costBasis":"list"}},
 "model_usage_since_last_result":{"claude-haiku-5-5":{"...same shape..."}},
 "subagent_stats":{"spawned":0,"...":0}}
```

- **`modelUsage` is the per-turn aggregate and includes subagents.** Second probe (main agent spawning one subagent, 4 API calls):
  - `result.usage` = `{4, 636, 31391, 17}`, exactly the last assistant message.
  - `modelUsage` = `{inputTokens:10, cacheCreation:38679, cacheRead:76687, outputTokens:280, costUSD:0.00706}`.
  - Summing the individual assistant messages gives cache-creation 38,679 and cache-read 76,687, which matches exactly. That includes the message tagged `parent_tool_use_id` (the subagent).
- `model_usage_since_last_result` is the safest field for a long-lived process that emits several results.
- `total_cost_usd` and `costUSD` are the CLI's own **list-price API-equivalent**, with `costBasis: "list"` even on a subscription. **No Claude price table is needed for live data.**
- Output tokens on streamed `assistant` events can lag the final count. In the probe the per-message outputs summed to 34 vs 280 in `modelUsage`. Treat transcript-derived output as a lower bound. Input and cache fields matched exactly.
- Per-model rows also carry `webSearchRequests`, thinking tokens and the 5m/1h cache-write split. Cache-write is priced differently for 5m and 1h.
- Transcript line, trimmed (`~/.claude/projects/<cwd>/<session>.jsonl`; each content block repeats the same `usage`, so dedupe on `message.id`):

```json
{"type":"assistant","requestId":"req_...","sessionId":"a02cf534-...","timestamp":"2026-10-16T11:36:15.738Z",
 "entrypoint":"sdk-cli","isSidechain":false,"model":"claude-opus-5-5","effort":"xhigh",
 "usage":{"input_tokens":2,"cache_creation_input_tokens":25170,"cache_read_input_tokens":10705,"output_tokens":571,
          "output_tokens_details":{"thinking_tokens":59},"service_tier":"standard","speed":"standard"}}
```

- `entrypoint` is `sdk-cli` for FalconDeck-spawned sessions, `cli` or `claude-desktop` for James's other use.
- Subagents write to `<session>/subagents/agent-*.jsonl` (304 files).

### Codex (`codex app-server`)

- Live: `thread/tokenUsage/updated` with `tokenUsage.{total,last}`, parsed in `notifications.rs:2109`. `total` is cumulative for the thread. `last` is the latest model request.
- `input_tokens` **includes** `cached_input_tokens`. This is the opposite of Claude, where `input_tokens` excludes cache. It must be normalised.
- Rollout (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), same data plus rate limits:

```json
{"type":"event_msg","payload":{"type":"token_count","info":{
  "total_token_usage":{"input_tokens":22066,"cached_input_tokens":11008,"cache_write_input_tokens":0,
                       "output_tokens":257,"reasoning_output_tokens":77,"total_tokens":22323},
  "last_token_usage":{"...same shape, per request..."},"model_context_window":258400},
 "rate_limits":{"limit_id":"codex","primary":{"used_percent":18.0,"window_minutes":10080,"resets_at":1788138629},
                "credits":{"has_credits":false,"unlimited":false},"plan_type":"pro"}}}
```

- Model per turn is in `turn_context.payload.model` (`gpt-6.1-sol`, `gpt-6.1-terra`, `codex-auto-review` and so on). There is **no cost**. A price table is needed.
- Sub-agents: `session_meta.payload.source = {"subagent":{"thread_spawn":{"parent_thread_id":...}}}` (at least 220 of 611 rollouts, from the top eight parents sampled, plus `{"subagent":{"other":"guardian"}}` for auto-review). These are separate threads with their own usage and a parent link.
- Repeated `token_count` events with an unchanged total must be deduped.

### Grok (ACP + vendor extension)

The daemon already receives `_x.ai/session/update` and reads it only for failures (`acp.rs:4333, 4614`). Real `turn_completed` from `~/.grok/sessions/.../updates.jsonl` (2,873 such lines across 1,048 session files):

```json
{"sessionUpdate":"turn_completed","prompt_id":"5df2cb0c-...","stop_reason":"end_turn","elapsed_ms":106510,
 "usage":{"inputTokens":491533,"outputTokens":6193,"totalTokens":497726,"cachedReadTokens":445696,
          "cacheCreationTokens":0,"reasoningTokens":4987,"modelCalls":13,"apiDurationMs":100989,
          "costUsdTicks":1195712000,
          "modelUsage":{"grok-4.7-build":{"inputTokens":491533,"...":"..."}}, "numTurns":13}}
```

- Per turn, per model, with cost. `costUsdTicks` is probably 1e-10 USD (here about $0.12); **confirm the unit before relying on it**.
- Every Grok update also carries `_meta.totalTokens` (context fill).
- Whether `inputTokens` includes cached read is unverified; the sample implies it does (445k of 491k).

### Other ACP agents (Cursor, Hermes, Gemini, OpenCode-via-ACP, custom)

- `session/update usage_update {used, size}` is context fill only, and is what we store today.
- The `session/prompt` **response** carries `usage {inputTokens, outputTokens, totalTokens}`. We only read it to detect empty or failed turns (`acp.rs:1062, 1155, 3592`). It is per prompt. **I did not capture a live sample per agent**; the shape comes from code. Cached and reasoning fields are optional and vary by agent.
- A custom harness (e.g. `myharness`, Pi SDK) will only report real cost if it puts `usage` and cost in the prompt response or `_meta`. Specify that as a requirement. See Phase 2 below.

### OpenCode

`~/.local/share/opencode/opencode.db`, `message.data` JSON (38,295 rows have tokens):

```json
{"role":"assistant","modelID":"claude-opus-4-5","providerID":"anthropic","agent":"explore",
 "cost":0,"tokens":{"input":0,"output":2083,"reasoning":0,"cache":{"read":68583,"write":3520}},
 "time":{"created":1768458685750,"completed":1768458732153}}
```

Per assistant message, with provider and model. `cost` is real for API-key providers (0 on subscriptions).

### Quotas

- Codex `rate_limits.primary.used_percent` rides on every rollout `token_count`, and the dashboard poll already covers it.
- Claude uses the Anthropic OAuth usage endpoint.
- Both are already shown in Settings → Usage.

## 3. Attribution

| Dimension | Status |
| --- | --- |
| Turn to thread | Yes. Events carry `thread_id`, and analytics follows the status transitions per thread. |
| Provider | Yes (`ThreadSummary.provider`). |
| **Model per turn** | **Gap.** `ThreadSummary.agent.model_id` is only the *current* selection, and analytics `turn` records omit it. The provider's own model (Claude `message.model`, `modelUsage` keys, Codex `turn_context.model`, Grok `modelUsage` keys) is the right source. It also captures auto-routing and per-subagent models. |
| Thread to parent | Yes: `ThreadOrigin::{AgentSpawn{parent_thread_id}, ScheduledTask{task_id}, Automation{automation_id, bot_id}}`. |
| Thread to bot | Partly. `analytics::bot_of` = bot home, or a direct child of the home. **Gaps:** grand-children (a bot's task spawning its own sub-tasks) are not attributed. A non-bot parent that is itself a bot task is missed. Scheduled runs are attributed only if `Automation.bot_id` is set (`bot_for_thread` in `bots.rs:156` also checks `owns_thread`). |
| Provider-internal sub-agents | **Claude:** inside `modelUsage`, so rolled into the parent turn. Correct for cost, but not separable by subagent model unless you also read `parent_tool_use_id` assistant messages. **Codex:** `spawn_agent` children are separate native threads (they surface as "Untitled" per project memory). I did not verify that their `thread/tokenUsage/updated` events reach the daemon with a child id that maps back to the parent live. **Offline** the rollout `source.thread_spawn.parent_thread_id` gives the link. |
| Snapshot at record time | **Required.** Threads get deleted, renamed, moved, re-modelled and archived. The record must freeze `{thread, parent_thread, root_thread, bot_id, origin kind, workspace/project, provider, model}` when written. Analytics today resolves titles and bots at read time, so old data degrades when threads are deleted. |
| Turn boundaries | Analytics derives turns from the status `running` to `idle` transitions. Usage should be bound to the same turn. Claude's `result` arrives once per user turn, so it is a natural anchor. |
| Cloud and remote hosts | Remote-host daemons enrolled via the relay have their own state. Aggregating needs a decision (§6). Not scoped here. |
| Non-FalconDeck usage | `~/.claude` also holds `cli` (3k msgs) and `claude-desktop` (20k msgs) sessions that share the same subscription. Useful as a separate "outside FalconDeck" bucket when comparing to quota. |

## 4. Backfill feasibility

| Source | Volume here | Gives | Linking to threads | Caveats |
| --- | --- | --- | --- | --- |
| `~/.claude/projects/**/*.jsonl` | 789 files, 4.9 GB, about 100k unique API messages, since about Apr 2026 | Per-message model, all token fields, timestamp, `isSidechain`, `entrypoint`, effort, `requestId` | `sessionId` equals `thread_states[].native_session_id` in `daemon-state.json`; `sdk-cli` marks FalconDeck-spawned | Dedupe on `message.id`. Output tokens may be a lower bound (see §2). No cost, so a price table is needed for history. `result` lines are not stored. Isolated copies and renamed dirs complicate cwd, but `sessionId` is stable. |
| `~/.codex/sessions/**/rollout-*.jsonl` | 611 files, 12 GB, Aug 2026 on | `token_count` per request with `last_token_usage`, `turn_context.model`, rate limits | Rollout id is the Codex thread id (`native_session_id`); `source.thread_spawn.parent_thread_id` gives the lineage | No cost. About 6 s to scan. |
| `~/.grok/sessions/*/*/updates.jsonl` | 1,048 sessions with `turn_completed` | Per-turn tokens, per-model, cost ticks | Session id equals `native_session_id` | Confirm tick unit. |
| `~/.local/share/opencode/opencode.db` | 38k messages | Tokens, cost, provider, model | Session id link | Old API-key usage (`claude-opus-4-5` etc.). |
| FalconDeck `analytics/events-*.jsonl` (Oct 2026 on) | 1,289 turns in Oct | Turn timing, Codex input and output, peak context | thread id | No model or cache split. Too thin to be the source of truth. Use only to cross-check. |
| ACP agents other than Grok and OpenCode (Cursor, Hermes, ...) | n/a | Mostly their own stores | | Not scoped. Backfill only if they keep usage locally. |

Conclusion: yes. Claude, Codex and Grok give about 2.5 months of reliable history now, OpenCode more. The backfill should be a single idempotent importer using the same record schema, tagged `src: "backfill"`. It keys each record on `(provider, message id or request id)` so a live capture and a backfill never double-count.

Reference scripts used for this report are throwaway (`/tmp/usage-scripts/scan_{claude,claude2,codex}.py`); a proper importer would live in the daemon.

## 5. Proposed design

### Record (one per turn per model)

Append-only `usage-YYYY-MM.jsonl` beside the analytics files. It uses the same writer thread, `try_send` and retention. It needs its own enable flag, because analytics can currently be turned off and usage should not silently stop.

```json
{"e":"usage","t":"2026-11-03T09:27:01Z","id":"claude:<message-or-turn-id>","src":"live|backfill",
 "th":"<thread>","par":"<parent thread|null>","root":"<root thread>","bot":"<bot id|null>",
 "org":"user|agent_spawn|scheduled|automation","ws":"<workspace id>","prov":"claude|codex|grok|opencode|acp:<id>","model":"claude-opus-5-5",
 "in":2,"cr":11886,"cw":18949,"out":4,"think":0,"calls":1,
 "cost":0.00391,"cost_src":"provider|table|none","tier":"standard|fast","effort":"xhigh"}
```

Normalisation rules:

- `in` is uncached input. For Codex and Grok, subtract cached reads from the provider's `input_tokens`.
- `cr` and `cw` are cache read and write.
- `out` includes reasoning, with `think` as a subset.
- `cost` is provider-reported when available. Otherwise it is computed from the price table at write time, with `cost_src` recording which.

### Capture points (all off the turn path)

| Harness | Hook | Detail |
| --- | --- | --- |
| Claude | `result` handling at `app/threads.rs:~1850` | One record per `modelUsage` entry, using `model_usage_since_last_result` if present, else `modelUsage`. Cost from `costUSD`. **Also fix `record_claude_run_usage` to use `modelUsage`.** |
| Codex | `thread/tokenUsage/updated` (`notifications.rs:275`) | Accumulate `last` per turn. Model from the turn's agent params, since app-server `turn/started` carries it (verify), else the thread selection at turn start. Flush on turn end. Dedupe unchanged totals. |
| Grok | `_x.ai/session/update turn_completed` (`acp.rs:4333`) | Currently only failures are read. One record per `modelUsage` entry, `costUsdTicks` to USD. |
| Other ACP | `session/prompt` response `usage` (`acp.rs:~3575`) | Input and output only, so no cache split. Model from the thread. Mark `cost_src:"table"` or `none`. |
| OpenCode | Per assistant `message` completion, or poll the DB | The path depends on the runner. Backfill covers history. Needs a spike. |
| Custom harness | Same ACP response, plus `_meta.cost` | Ask `myharness` (Pi SDK) to return `usage` and `cost` so API-priced runs report real figures. |

Attribution (`par`, `root`, `bot`, `org`) is resolved once at write time. Extend `bot_of` to walk all the way up the parent chain (cycle-guarded), and add `Automation.bot_id` and `ScheduledTask`.

### Price table

- A bundled `prices.json` keyed by `(provider, model pattern)` with `in`, `cr`, `cw5m`, `cw1h`, `out`, per million tokens, plus an `effective_from` date.
- Used only where the provider reports no cost: Codex, ACP agents, and Claude backfill.
- User-overridable (Settings), since custom or cheaper models at API prices will be added.
- Store the cost on the record at write time, and also keep the raw tokens so costs can be recomputed when prices change.
- **I could not verify the current list prices for the Claude 5.x, GPT-6.x or Grok 4.7 families from here.** A person has to fill the table from official pricing pages. For Claude, the CLI's `costUSD` figures can be used as a cross-check for the table.
- Subscription costs are separate settings: `{provider, plan, monthly_amount, currency}` (Claude Max about £150, Codex Pro about $175-200). Derive "effective cost per million tokens" and "% of monthly allowance used" by combining them with the Usage panel's window percentages.
- The primary display is tokens. The API-equivalent cost is a labelled secondary column.

### Query and API

- `GET /api/analytics/usage?days=N&group=bot|provider|model|thread|day` in the same local-only HTTP style. Not an RPC, so there is no mobile exposure initially.
- Add `usage` to `analytics/summary` for the Settings table.

## 6. Phases and effort (S ≤ 1 day, M 2-4 days, L > 1 week)

| Phase | Work | Effort |
| --- | --- | --- |
| 0 | Fix Claude `result.usage` bug in run usage, correct the stream.rs comment, add the facts to `docs/ANALYTICS.md`. | S |
| 1a | `usage` record + capture for Claude, Codex, Grok; write-time attribution with full parent walk; usage aggregation endpoint; unit tests with the payloads above. | M |
| 1b | Minimal view: a table of tokens by bot x harness x model for 7 and 30 days (Settings → Analytics, or a daemon API plus `falcondeck_get` resource for agents). | S |
| 1c | Backfill importer for Claude, Codex, Grok (idempotent, `src:backfill`), plus session to thread mapping and an "unattributed (thread deleted)" bucket. | M |
| 2 | Price table + overrides, API-equivalent cost column, subscription cost settings, generic ACP prompt `usage` capture, OpenCode spike, `myharness` cost reporting. | M |
| 3 | Dashboard: daily series, drill-down bot to thread, top threads by tokens, model mix chart. | M |
| 4 | Flags: expensive model on a trivial turn (low output and no tool calls on Opus or `xhigh`), subagents inheriting the main model, repeated large cache creation (cache thrash), scheduled tasks that burn tokens and return nothing (reuse `automation.health`), tokens per commit. | M |
| 5 | Quota correlation: tokens per % of the weekly Claude or Codex window, projected burn and reset; per-host aggregation for relay-enrolled remote daemons; mobile surface; a bot-facing `falcondeck_get` resource. | M-L |

First slice = Phase 0 + 1a + 1b, about one week of work, and the backfill (1c) after it.

## 7. Open questions and risks

- **Turn identity.** Analytics turns come from thread status transitions. Claude `result` and Codex `turn/completed` are cleaner anchors. Pick one and use it for both, otherwise the two tables disagree.
- **Cost of the recording path.** The 4,096-entry `try_send` queue drops under pressure. Usage records are low volume, so it should be fine, but billing data should not be silently dropped. Consider a separate channel or a drop counter.
- **Remote hosts** (relay-enrolled daemons) hold their own usage. Decide whether the desktop aggregates them or each host reports separately.
- **Retention.** Analytics retains 12 months by default. Usage records are about 250 bytes each, which is fine.
- **Privacy.** Records contain no content, only ids and counts. Keep them behind the local-only API.
- **Claude output lower bound in backfill** (see §2) means backfilled output tokens, and therefore cost, are floors.
- **Provider unit quirks** to confirm during Phase 1: Grok `costUsdTicks`, whether Grok and ACP `inputTokens` include cache, and whether Codex children report live to the daemon with a mappable id.

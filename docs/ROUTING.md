# Auto routing

Auto routing picks the harness, model and effort for a new thread. It decides
once, when the thread is created. Later messages in the thread don't change the
choice.

## Flow

1. A caller asks for auto. It can be an agent calling `falcondeck_create_thread`
   with `model: "auto"` or `provider: "auto"`, or the desktop composer with its
   **Auto** chip on.
2. The daemon sends the brief to a classifier on OpenRouter's decisions
   endpoint. The default classifier is `typesafe/jev-1.13`.
   - It uses the OpenRouter key saved under Models & keys.
   - Each call takes about 0.3 s and costs a fraction of a cent.
   - The classifier answers four fixed questions:
     - **task type**: one of the configured task types.
     - **difficulty**: 1 to 5.
     - **production risk**: whether the work touches deploys, migrations, auth,
       payments or secrets.
     - **needs social**: whether the work needs live X or social data.
3. The rules in Settings → Routing are checked from top to bottom.
   - A rule matches when the task type, the difficulty range and the flags all
     match.
   - Rules are skipped when the task-type confidence is below
     `min_confidence_percent`.
   - The first matching rule wins if it has a usable target. Otherwise the
     fallback list is used.
4. A target is skipped in any of these cases:
   - its harness isn't installed;
   - its harness needs sign-in;
   - its model isn't in the harness's model list (checked only when that list
     is hydrated, meaning it has more than one entry);
   - any usage window of its subscription is at or above
     `usage_ceiling_percent`.

   Usage comes from the cached provider usage overview. OpenCode targets map to
   `zai` or `openrouter` by model prefix. If every option is over its limit, a
   second pass ignores the limits.
5. If the classifier is unreachable or times out after 8 s, the fallback list
   is used. The decision never blocks thread creation on the classifier.

## Surfaces

- **Agents:** `falcondeck_create_thread` with `model: "auto"`.
  - `provider` limits the choice to one harness.
  - An explicit `reasoning_effort` overrides the routed effort.
  - The tool result includes a `- Auto route: …` line that explains the choice.
  - Cloud threads and threads without a prompt are rejected.
- **Desktop:** the composer's **Auto** chip, shown for new local threads while
  routing is enabled.
  - It calls `routing.preview` and starts the thread with the routed choice.
  - Permission and sandbox modes come from the routed harness's remembered
    composer selection.
  - Sends that include attachments keep the composer's own choice.
- **Playground:** Settings → Routing → Try a prompt.
  - It shows the classification, the matching rule, the target, and any skipped
    targets with the reason each was skipped.
  - API: `POST /api/routing/preview` (`RoutePreviewRequest`). Remote clients use
    the `routing.preview` RPC.
- **Bots:** the default bot instructions tell bots to create tasks with
  `model: "auto"`.

## Storage and analytics

- Settings are stored in `FalconDeckPreferences.routing`
  (`crates/falcondeck-core/src/routing.rs`). Missing fields load the defaults.
  Saving `{}` resets everything to the defaults.
- The daemon normalizes saved settings (`app/routing.rs::normalize_routing`).
  It trims values, deduplicates task types and clamps difficulties.
- Every routed or explicit delegation writes a `route` record to the analytics
  log:
  - task type, confidence, difficulty and flags;
  - the rule that matched;
  - the chosen provider, model and effort;
  - whether the choice was auto.

  Use these records to tune the rules.

## Defaults

| Rule | Condition | Targets |
|---|---|---|
| Production risk | risk flag | Sol high, Opus high |
| Needs X / social | social flag | Grok 4.7, Sol medium |
| UI | ui | Opus medium, Sol medium |
| Mechanical | mechanical | GLM, Sonnet low |
| Easy work | difficulty ≤ 2 | GLM, Sol low |
| Research & writing | research, writing; difficulty ≤ 3 | GLM, Sol medium |
| Backend & ops | backend, ops | Sol medium, Opus medium |
| Review | review | Sol medium, Opus medium |
| *Fallback* | — | Sol medium, Opus medium |

The models behind these names:

- **Sol**: `codex` / `gpt-6.1-sol`.
- **Opus**: `claude` / `opus`.
- **GLM**: `opencode` / `zai-coding-plan/glm-5.3`. No effort is set, because
  OpenCode efforts are per-model variants and a wrong one kills the turn.

## Not yet built

- Splitting a task into a plan on a strong model, implementation on a cheap
  model, and an automatic lighter review afterwards.
- Showing routing decisions in the Analytics overview.

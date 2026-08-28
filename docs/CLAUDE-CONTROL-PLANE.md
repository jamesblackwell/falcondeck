# Claude control plane (bb outcomes, CLI path)

Status: Phase 0 probed 2026-08-25 against Claude Code **2.1.238**
(`/Users/James/.local/bin/claude`). Implementation follows
`docs/PROVIDERS.md` native-Claude-first: no Agent SDK in the daemon.

bb’s Claude path is a Node bridge around `@anthropic-ai/claude-agent-sdk`.
FalconDeck keeps `claude -p` stream-json and takes the **outcomes** that
probe green. This file is the matrix later phases read; they do not guess
from March 2026 docs.

## Probe results (2.1.238)

| Flag / behavior | Result |
|---|---|
| `--fork-session` (with `--resume` / `--continue`) | **Present**, but it is **fork-at-end only**: a new session id for the whole resumed transcript. There is no `upToMessageId` / `lastTurnId` on the CLI. Do **not** set `supports_forking` until we can branch at a turn boundary — retry-from-here would otherwise keep later turns. “Fork thread” can still use this later as a whole-session copy; today it stays the same-provider transcript handoff. |
| `--permission-prompt-tool` | **Gone.** Approvals stay PreToolUse hook → daemon HTTP. Phase 3 is path B (AskUserQuestion / ExitPlanMode cards on the hook and NDJSON stream). |
| Model list command | **None.** `system` init has the current `model` only, plus `capabilities` protocol versions (`interrupt_receipt_v1`, …), not a catalog. |
| `--model` help aliases | Quoted examples: `fable`, `opus`, `sonnet`, and full name `claude-fable-5`. `haiku` is omitted from the examples but still runs. |
| Extra picker rows | `~/.claude.json` `additionalModelOptionsCache` (e.g. `claude-fable-5[1m]`). |
| `--input-format stream-json` after `result` | **Works.** A second user line on the same stdin produced a second `result` and the process stayed alive. Phase 4 (keep the CLI across turns) is unblocked. `--print` help still says “print and exit”; stream-json input does not. |
| `--setting-sources` | Present (`user`, `project`, `local`). |
| `--replay-user-messages` | Present (stream-json in and out). |
| Claude-over-ACP | Still an opt-in `providers.json` id that must not be `claude`. Native thinking already streams (`extract_claude_thinking_chunk`); the ACP experiment is for permission RPCs and resume comparison, not thinking. |

## Phase mapping

| Phase | Gate from this probe | Status |
|---|---|---|
| 1 Live picker catalog | Always (curated ∩ extras; no CLI list command) | In progress |
| 2 Native fork via `ProviderRuntime` | `--fork-session` is fork-at-end, not a turn checkpoint | Blocked for `supports_forking` / retry-from-here. Codex-only `fork_thread` dispatch cleanup can still land. |
| 3 Approvals / questions / plan | Path B (no `--permission-prompt-tool`) | AskUserQuestion and ExitPlanMode are first-class cards on the PreToolUse hook. They are never auto-allowed. Plan approval restores the pre-plan permission mode (or `acceptEdits`). |
| 4 Long-lived CLI process | stdin-after-result works | Park after a successful `result` and reuse stdin when cwd/model/effort/permission/hooks/MCP still match. Mismatch or a failed turn still `--resume`s. |
| 5 `claude-acp` opt-in | Not default | Later |

## ACP experiment command

Id must not be `claude` (builtins cannot be overridden):

```jsonc
"providers": {
  "claude-acp": {
    "command": ["npx", "--yes", "@zed-industries/claude-code-acp"],
    "label": "Claude (ACP)"
  }
}
```

Prefer `@agentclientprotocol/claude-agent-acp` if that package is what `npx`
resolves on the machine. Score against native: permission round-trips,
`session/load` vs `--resume` + `~/.claude/projects`, AskUserQuestion, plan,
interrupt/steer. Do not promote it as the default Claude runtime from this
file.

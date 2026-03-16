# Agent Integration Paths

Research date: 2026-03-14
Updated: 2026-03-14

## Claude Code

### Recommended Path: CLI Subprocess with Structured I/O

Claude Code does not have an app-server equivalent. The official integration surface for third-party UIs is the CLI with structured JSON I/O.

**Reference implementation**: Happy Engineering (`github.com/slopus/happy`, MIT licensed) uses this approach successfully.

**How it works**: Spawn `claude` CLI as a subprocess per session. Use structured JSON for input/output. Handle permissions via MCP tool. Resume sessions across turns.

**Key CLI flags for embedding**:

| Flag | Purpose |
|---|---|
| `--output-format stream-json` | Structured streaming events (newline-delimited JSON) |
| `--input-format stream-json` | Structured JSON input via stdin |
| `--include-partial-messages` | Receive all streaming deltas as they're generated |
| `--verbose` | Full turn-by-turn output |
| `--permission-prompt-tool` | Route permission prompts to an MCP tool (enables interactive approvals in non-interactive mode) |
| `--resume <id>` | Resume a specific session by ID |
| `--session-id <uuid>` | Set a specific session ID for the conversation |
| `--continue` | Continue the most recent session in current directory |
| `--fork-session` | Create new session ID when resuming (branch a session) |
| `--permission-mode` | Set initial permission mode (default, plan, acceptEdits, bypassPermissions) |
| `--model` | Model selection (alias like `sonnet`/`opus` or full model ID) |
| `--effort` | Effort level (low, medium, high, max) |
| `--allowedTools` | Tools that execute without prompting |
| `--disallowedTools` | Tools removed from model context |
| `--mcp-config` | Load MCP servers from JSON |
| `--append-system-prompt` | Add custom instructions while keeping default behavior |
| `--max-turns` | Limit agentic turns per invocation |
| `--max-budget-usd` | Spending cap per invocation |
| `--no-session-persistence` | Disable session saving to disk |
| `--name` | Set display name for session |
| `--add-dir` | Add additional working directories |
| `--worktree` | Start in isolated git worktree (optional) |

**Per-turn flow**:
```
FalconDeck Rust backend:
  1. Spawn: claude -p "<user message>"
       --output-format stream-json
       --input-format stream-json
       --include-partial-messages
       --verbose
       --session-id <uuid>
       --permission-prompt-tool mcp__falcondeck__approve
       --permission-mode <mode>
       --model <model>
       --mcp-config ./mcp.json
  2. Read stdout: parse newline-delimited JSON events
  3. Handle permissions: via MCP tool callback
  4. Process exits when turn completes
  5. For next turn: spawn again with --resume <session-id>
```

**Auth**: Uses the user's existing `claude auth login` session (claude.ai subscription). No API keys required. No Anthropic terms conflicts.

**Session storage**: Claude Code stores sessions at `~/.claude/projects/<project-hash>/`. Sessions persist between invocations and can be resumed by ID.

**Hook system**: Claude Code has a rich hook system for lifecycle events:
- `SessionStart` — fires when session begins (enables session ID tracking)
- `SessionEnd` — fires when session ends
- `PreToolUse` — fires before tool execution (can block/modify)
- `PostToolUse` — fires after tool execution (can log/transform)
- `UserPromptSubmit` — fires when user sends a message
- `Stop` — fires when agent stops

Happy Engineering uses the hook system to track session IDs and sync events to their relay server. FalconDeck can use the same pattern.

**Difference vs Codex app-server**: Claude Code spawns a new process per turn and resumes via session files on disk. Codex app-server is a long-lived process with persistent JSON-RPC connection. The user experience is equivalent — session state persists either way — but Claude Code has a small startup cost per turn.

**Advantages over Codex app-server**:
- Hook system is richer than anything Codex offers
- `--permission-prompt-tool` allows routing permissions to custom MCP tools
- `--input-format stream-json` enables structured input
- Session forking (`--fork-session`) for branching conversations
- `--append-system-prompt` for per-session customization without replacing defaults

### Not Recommended: Claude Agent SDK

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, available in Python and TypeScript) is a library for building custom agents with API key authentication. It is NOT the right path for embedding Claude Code because:

1. **Auth model**: Requires Anthropic API keys (Console, Bedrock, Vertex). Does not use claude.ai subscription login.
2. **Anthropic terms**: "Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."
3. **Runtime dependency**: Requires Node.js or Python process.
4. **Different product**: The Agent SDK is for building YOUR OWN agents. FalconDeck wants to control the Claude Code product itself.

Note: Harnss uses the Agent SDK but points it at the user's local Claude Code binary. This works technically but may be in a grey area with Anthropic's terms.

### Also Available: Remote Control

Claude Code has a built-in remote control feature (`claude --remote-control` or `claude --rc`) that enables controlling a local session from claude.ai or the Claude mobile app. This is Anthropic's own mobile handoff solution. FalconDeck could potentially integrate with this.

---

## Codex (OpenAI)

### Recommended Path: app-server (JSON-RPC over stdio)

Codex app-server is the official integration surface for embedding Codex into rich UIs. OpenAI explicitly recommends it for full embedded Codex experiences.

**Reference implementation**: CodexMonitor (`github.com/Dimillian/CodexMonitor`) has a production Rust implementation.

**How it works**: Spawn `codex app-server` as a long-lived subprocess. Communicate via bidirectional JSON-RPC over stdio (newline-delimited JSON).

**Lifecycle**:
```
FalconDeck Rust backend:
  1. Spawn: codex app-server (long-lived process)
  2. Send: initialize + initialized handshake
  3. Send: account/read (check auth)
  4. Send: model/list (available models)
  5. Send: thread/start (create thread with cwd, model)
  6. Send: turn/start (user message)
  7. Receive: streaming notifications (item/agentMessage/delta, item/started, etc.)
  8. Handle: server-initiated approval requests
  9. Send: turn/start (next user message, same thread)
  ... repeat ...
```

**Auth**: Uses the user's existing Codex/OpenAI login. Handled by the app-server process.

**Session storage**: `$CODEX_HOME/sessions/` (default: `~/.codex/sessions/`). JSONL transcript files.

**Key advantages**:
- Long-lived process (no startup cost per turn)
- Full JSON-RPC protocol with 60+ methods
- Auto-generated TypeScript types via `codex app-server generate-ts`
- Backward-compatible protocol
- Rust speaks it natively (no sidecar needed)

See `07-codex-app-server-protocol.md` for the complete protocol reference.

### Not Recommended: Codex MCP Server

`codex mcp-server` exposes Codex via standard MCP protocol. Less complete than app-server:
- Session resume is experimental (`experimental_resume`, undocumented)
- Version fragmentation (must check CLI version at runtime)
- Permissions via MCP elicitation (less mature)
- Event format requires heavy translation

Happy Engineering uses this path and experiences patchier Codex integration compared to Claude. See `05-happy-claude-vs-codex.md`.

---

## Comparison

| Aspect | Claude Code (CLI subprocess) | Codex (app-server) |
|---|---|---|
| Process model | New process per turn, resume via session files | Long-lived process, persistent connection |
| Protocol | Structured JSON via stdio flags | JSON-RPC over stdio |
| Auth | User's claude.ai subscription | User's OpenAI login |
| Permissions | Via `--permission-prompt-tool` MCP | Via server-initiated JSON-RPC requests |
| Streaming | `--output-format stream-json` | Notification events |
| Session resume | `--resume <id>` flag | `thread/resume` method |
| Hooks | Rich hook system (SessionStart, PreToolUse, PostToolUse, etc.) | None |
| Type generation | None (parse JSON) | `codex app-server generate-ts` |
| Rust compatibility | Subprocess spawn + stdio parsing | Native JSON-RPC over stdio |
| Reference impl (open source) | Happy Engineering (MIT) | CodexMonitor (MIT) |
| Per-turn startup cost | Small (process spawn) | None (persistent) |
| Mobile handoff | Built-in `--remote-control` | Via daemon (CodexMonitor) |

## Future Considerations

1. Anthropic may ship a `claude app-server` equivalent. The official Claude Code desktop app likely uses something structured internally.
2. The `--input-format stream-json` flag suggests Anthropic is moving toward richer structured I/O.
3. The `--remote-control` feature is Anthropic's own relay/mobile-handoff solution — worth monitoring for integration opportunities.

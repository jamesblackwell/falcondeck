# Why Happy Works Better With Claude Than Codex

Research date: 2026-03-14

Based on source code analysis of the Happy Engineering codebase (`github.com/slopus/happy`).

## Claude Integration in Happy

### How it works
- Spawns Claude Code CLI as a child process via `claudeLocal.ts`
- Uses a **hook server** (local HTTP) to receive session ID notifications from Claude Code's hook system
- Creates a `Session` object that syncs events to the relay server
- Message queue (`MessageQueue2`) batches user messages with mode metadata (permission mode, model, system prompt, allowed tools)
- The `loop()` function manages the Claude Code lifecycle: spawning, message forwarding, mode changes, session scanning

### Key integration points
- **Hook system**: Claude Code fires hooks on `SessionStart`, enabling Happy to automatically discover session IDs
- **SDK metadata extraction**: `extractSDKMetadataAsync()` pulls tools and slash commands from the SDK and updates session metadata
- **MCP integration**: Happy runs its own MCP server (`startHappyServer`) and passes it to Claude Code
- **Permission modes**: 7 modes supported (default, acceptEdits, plan, bypassPermissions, etc.), mapped at SDK boundary
- **Offline support**: If relay server is unreachable, Claude runs locally with hot reconnection

### Source files
- `packages/happy-cli/src/claude/runClaude.ts` — main entry point
- `packages/happy-cli/src/claude/claudeLocal.ts` — CLI subprocess management
- `packages/happy-cli/src/claude/loop.ts` — message loop
- `packages/happy-cli/src/claude/session.ts` — session sync
- `packages/happy-cli/src/claude/sdk/` — SDK metadata extraction

---

## Codex Integration in Happy

### How it works
- Uses `CodexMcpClient` which connects to Codex via the **MCP protocol** (not app-server)
- Spawns `codex mcp-server` (or `codex mcp` for older versions) as a subprocess
- Uses `@modelcontextprotocol/sdk` (MCP SDK) for communication
- Events arrive as MCP notifications on `codex/event` channel
- Permissions handled via MCP **elicitation requests**

### Key integration points
- **Version detection**: Must check `codex --version` at runtime to determine command (`mcp-server` vs `mcp`)
- **Event translation**: Raw Codex MCP events require heavy mapping via `mapCodexMcpMessageToSessionEnvelopes()`, `ReasoningProcessor`, and `DiffProcessor`
- **Session resume**: Uses `config.experimental_resume` — cast to `any` in source code, indicating it's undocumented
- **Session ID tracking**: Manual extraction from events via `updateIdentifiersFromEvent()`, no hook system equivalent
- **MCP bridge**: Happy's own MCP server is passed to Codex as an stdio bridge (`happy-mcp.mjs`), not directly as HTTP

### Source files
- `packages/happy-cli/src/codex/runCodex.ts` — main entry point
- `packages/happy-cli/src/codex/codexMcpClient.ts` — MCP client wrapper
- `packages/happy-cli/src/codex/executionPolicy.ts` — permission mode mapping
- `packages/happy-cli/src/codex/utils/permissionHandler.ts` — MCP elicitation handler
- `packages/happy-cli/src/codex/utils/sessionProtocolMapper.ts` — event format translation

---

## Specific Issues With Codex Integration

### 1. MCP protocol is less mature for agent control
Claude's Agent SDK was purpose-built for controlling Claude Code. Codex uses the generic MCP protocol, which was designed for tool/resource access, not agent lifecycle management. Agent control concepts (session resume, permission callbacks, turn management) are bolted on via MCP extensions.

### 2. Session resume is experimental
```typescript
// From runCodex.ts — note the `as any` cast
(startConfig.config as any).experimental_resume = resumeFile;
```
Claude's resume is a first-class SDK option: `resume: sessionId`.

### 3. Version fragmentation
```typescript
// From codexMcpClient.ts — runtime version check required
function getCodexMcpCommand(): string | null {
    const version = execSync('codex --version', { encoding: 'utf8' }).trim();
    // Version >= 0.43.0-alpha.5 has mcp-server
    // Older versions use mcp
}
```
Claude's SDK handles versioning internally.

### 4. Event format translation overhead
Happy needs three separate processors to convert Codex events into its unified format:
- `mapCodexMcpMessageToSessionEnvelopes()` — general event mapping
- `ReasoningProcessor` — reasoning delta accumulation and tool call extraction
- `DiffProcessor` — unified diff tracking from `turn_diff` events

Claude events map more directly to Happy's session protocol.

### 5. No hook system equivalent
Claude Code fires `SessionStart` hooks, enabling automatic session ID discovery. Codex requires manual event parsing:
```typescript
// From codexMcpClient.ts
private updateIdentifiersFromEvent(msg: any): void {
    // Must extract sessionId and conversationId from raw events
}
```

### 6. Permission handling is indirect
- Claude: Direct callback function `canUseTool()` — synchronous promise resolution
- Codex: MCP elicitation requests — requires registering handlers on the MCP client, parsing structured elicitation params, and responding via MCP protocol

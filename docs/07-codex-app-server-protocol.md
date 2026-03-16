# Codex App Server: Full Protocol Reference

Research date: 2026-03-14

Sources: Harnss auto-generated types (`codex app-server generate-ts`), CodexMonitor Rust backend, Happy Codex provider.

## Overview

Codex app-server is a long-lived process that exposes the full Codex agent harness over a bidirectional JSON-RPC interface. It is the official integration surface for embedding Codex into rich UIs.

- **Transport**: stdio with newline-delimited JSON (default), experimental WebSocket mode also exists
- **Protocol**: JSON-RPC 2.0 (requests have `id` + `method` + `params`, responses have `id` + `result`/`error`, notifications have `method` + `params` only)
- **Type generation**: `codex app-server generate-ts --out <dir>` produces TypeScript types for all protocol messages (generated via `ts-rs`)
- **Backward compatibility**: Protocol is designed to be backward compatible; older clients can talk to newer servers
- **Experimental API**: Some methods/fields are gated behind `experimentalApi: true` in the initialize capabilities

## Lifecycle

```
Client                           App Server
  |                                  |
  |-- initialize ------------------>|  (handshake with client info + capabilities)
  |<-------------- response --------|  (server info + capabilities)
  |-- initialized (notification) -->|  (client ready)
  |                                  |
  |-- account/read ---------------->|  (check auth status)
  |<-------------- response --------|  (account info or requiresOpenaiAuth)
  |                                  |
  |-- model/list ------------------>|  (available models)
  |<-------------- response --------|  (model list with isDefault flags)
  |                                  |
  |-- thread/start ---------------->|  (create thread with cwd, model, approvalPolicy)
  |<-------------- response --------|  (thread object with id)
  |                                  |
  |-- turn/start ------------------>|  (user message + config)
  |<-- turn/started (notification) -|  (turn begins)
  |<-- item/started (notification) -|  (tool/action begins)
  |<-- item/agentMessage/delta -----|  (streaming text)
  |<-- item/completed (notif) ------|  (tool/action ends)
  |<-- turn/completed (notif) ------|  (turn ends)
  |                                  |
  |   ... more turns ...             |
  |                                  |
  |-- turn/interrupt --------------->|  (cancel running turn)
```

## Initialize Handshake

```json
// Client -> Server
{
  "id": 1,
  "method": "initialize",
  "params": {
    "clientInfo": {
      "name": "falcondeck",
      "title": "FalconDeck",
      "version": "0.1.0"
    },
    "capabilities": {
      "experimentalApi": true
    }
  }
}

// Server -> Client (response)
{
  "id": 1,
  "result": { /* server info, capabilities */ }
}

// Client -> Server (notification, no id)
{
  "method": "initialized",
  "params": {}
}
```

## Client Requests (Client -> Server)

### Thread Management
| Method | Params | Description |
|---|---|---|
| `thread/start` | `{ cwd, model?, approvalPolicy?, sandbox?, experimentalRawEvents?, persistExtendedHistory? }` | Create new thread |
| `thread/resume` | `{ threadId }` | Resume existing thread |
| `thread/fork` | `{ threadId }` | Fork thread into new branch |
| `thread/list` | `{ cursor?, limit?, sortKey?, sourceKinds? }` | List threads (paginated) |
| `thread/loaded/list` | `{ ... }` | List currently loaded threads |
| `thread/read` | `{ ... }` | Read thread content |
| `thread/archive` | `{ threadId }` | Archive thread |
| `thread/unarchive` | `{ ... }` | Unarchive thread |
| `thread/name/set` | `{ threadId, name }` | Rename thread |
| `thread/compact/start` | `{ threadId }` | Start context compaction |
| `thread/rollback` | `{ ... }` | Rollback thread to earlier state |

### Turn Management
| Method | Params | Description |
|---|---|---|
| `turn/start` | `{ threadId, input, cwd?, model?, effort?, approvalPolicy?, sandboxPolicy?, collaborationMode?, serviceTier? }` | Start agent turn with user message |
| `turn/steer` | `{ threadId, expectedTurnId, input }` | Steer running turn with additional input |
| `turn/interrupt` | `{ threadId, turnId }` | Interrupt running turn |

### Review
| Method | Params | Description |
|---|---|---|
| `review/start` | `{ threadId, target, delivery? }` | Start code review |

### Models
| Method | Params | Description |
|---|---|---|
| `model/list` | `{ includeHidden? }` | List available models |

### Account/Auth
| Method | Params | Description |
|---|---|---|
| `account/read` | `{ refreshToken? }` | Read account info and auth status |
| `account/login/start` | `{ type: "chatgpt" }` | Start OAuth login flow |
| `account/login/cancel` | `{ ... }` | Cancel login |
| `account/logout` | | Logout |
| `account/rateLimits/read` | | Read current rate limits |

### Config
| Method | Params | Description |
|---|---|---|
| `config/read` | `{ ... }` | Read configuration |
| `config/value/write` | `{ ... }` | Write single config value |
| `config/batchWrite` | `{ ... }` | Write multiple config values |
| `configRequirements/read` | | Read config requirements |
| `config/mcpServer/reload` | | Reload MCP server config |

### Skills
| Method | Params | Description |
|---|---|---|
| `skills/list` | `{ cursor?, limit? }` | List available skills |
| `skills/remote/list` | `{ ... }` | List remote skills |
| `skills/remote/export` | `{ ... }` | Export skills |
| `skills/config/write` | `{ ... }` | Write skills config |

### Apps
| Method | Params | Description |
|---|---|---|
| `app/list` | `{ cursor?, limit? }` | List available apps |

### MCP
| Method | Params | Description |
|---|---|---|
| `mcpServerStatus/list` | `{ cursor?, limit? }` | List MCP server status |
| `mcpServer/oauth/login` | `{ ... }` | Start MCP server OAuth login |

### Collaboration
| Method | Params | Description |
|---|---|---|
| `collaborationMode/list` | `{}` | List collaboration modes |

### Experimental Features
| Method | Params | Description |
|---|---|---|
| `experimentalFeature/list` | `{ cursor?, limit? }` | List experimental features |

### Utility
| Method | Params | Description |
|---|---|---|
| `command/exec` | `{ ... }` | Execute shell command |
| `feedback/upload` | `{ ... }` | Upload feedback |
| `fuzzyFileSearch` | `{ ... }` | Fuzzy file search in workspace |
| `externalAgentConfig/detect` | `{ ... }` | Detect external agent configs |
| `externalAgentConfig/import` | `{ ... }` | Import external agent config |

### Legacy Methods (v1 API, still available)
| Method | Description |
|---|---|
| `newConversation` | Create conversation (v1) |
| `resumeConversation` | Resume conversation (v1) |
| `forkConversation` | Fork conversation (v1) |
| `archiveConversation` | Archive conversation (v1) |
| `listConversations` | List conversations (v1) |
| `getConversationSummary` | Get conversation summary (v1) |
| `sendUserMessage` | Send user message (v1) |
| `sendUserTurn` | Send user turn (v1) |
| `interruptConversation` | Interrupt conversation (v1) |
| `addConversationListener` | Add listener (v1) |
| `removeConversationListener` | Remove listener (v1) |
| `gitDiffToRemote` | Git diff to remote |
| `loginApiKey` | Login with API key |
| `loginChatGpt` | Login via ChatGPT |
| `getAuthStatus` | Get auth status (v1) |
| `getUserSavedConfig` | Get user config (v1) |
| `setDefaultModel` | Set default model (v1) |
| `getUserAgent` | Get user agent string |
| `userInfo` | Get user info |
| `execOneOffCommand` | Execute one-off command |

## Server Notifications (Server -> Client)

### Thread Events
| Method | Params Type | Description |
|---|---|---|
| `thread/started` | ThreadStartedNotification | Thread created/loaded |
| `thread/status/changed` | ThreadStatusChangedNotification | Thread status changed |
| `thread/archived` | ThreadArchivedNotification | Thread archived |
| `thread/unarchived` | ThreadUnarchivedNotification | Thread unarchived |
| `thread/name/updated` | ThreadNameUpdatedNotification | Thread renamed |
| `thread/tokenUsage/updated` | ThreadTokenUsageUpdatedNotification | Token usage stats |
| `thread/compacted` | ContextCompactedNotification | Context compaction done |

### Turn Events
| Method | Params Type | Description |
|---|---|---|
| `turn/started` | TurnStartedNotification | Turn begins (includes turn.id) |
| `turn/completed` | TurnCompletedNotification | Turn ends (includes status, error) |
| `turn/diff/updated` | TurnDiffUpdatedNotification | Diff updated during turn |
| `turn/plan/updated` | TurnPlanUpdatedNotification | Plan steps updated |

### Item Events (Tool Execution)
| Method | Params Type | Description |
|---|---|---|
| `item/started` | ItemStartedNotification | Item begins (commandExecution, fileChange, mcpToolCall, webSearch, imageView) |
| `item/completed` | ItemCompletedNotification | Item ends (includes status, exitCode) |
| `rawResponseItem/completed` | RawResponseItemCompletedNotification | Raw response item completed |

### Streaming Deltas
| Method | Params Type | Description |
|---|---|---|
| `item/agentMessage/delta` | AgentMessageDeltaNotification | Streaming text from agent |
| `item/plan/delta` | PlanDeltaNotification | Streaming plan updates |
| `item/commandExecution/outputDelta` | CommandExecutionOutputDeltaNotification | Streaming command output |
| `item/commandExecution/terminalInteraction` | TerminalInteractionNotification | Terminal interaction required |
| `item/fileChange/outputDelta` | FileChangeOutputDeltaNotification | Streaming file change output |
| `item/mcpToolCall/progress` | McpToolCallProgressNotification | MCP tool call progress |

### Reasoning
| Method | Params Type | Description |
|---|---|---|
| `item/reasoning/textDelta` | ReasoningTextDeltaNotification | Streaming reasoning text |
| `item/reasoning/summaryTextDelta` | ReasoningSummaryTextDeltaNotification | Streaming reasoning summary |
| `item/reasoning/summaryPartAdded` | ReasoningSummaryPartAddedNotification | Reasoning summary part added |

### Account
| Method | Params Type | Description |
|---|---|---|
| `account/updated` | AccountUpdatedNotification | Account info changed |
| `account/rateLimits/updated` | AccountRateLimitsUpdatedNotification | Rate limits changed |
| `account/login/completed` | AccountLoginCompletedNotification | Login flow completed |

### Other
| Method | Description |
|---|---|
| `model/rerouted` | Model was rerouted |
| `app/list/updated` | App list changed |
| `mcpServer/oauthLogin/completed` | MCP OAuth login done |
| `configWarning` | Config warning |
| `deprecationNotice` | Deprecation notice |
| `fuzzyFileSearch/sessionUpdated` | Fuzzy search results updated |
| `fuzzyFileSearch/sessionCompleted` | Fuzzy search completed |
| `error` | Error notification |

## Server Requests (Server -> Client, requires response)

These are requests the server sends TO the client, requiring a response.

| Method | Params Type | Description |
|---|---|---|
| `item/commandExecution/requestApproval` | CommandExecutionRequestApprovalParams | Approve shell command execution |
| `item/fileChange/requestApproval` | FileChangeRequestApprovalParams | Approve file modification |
| `item/tool/requestUserInput` | ToolRequestUserInputParams | Request structured user input |
| `skill/requestApproval` | SkillRequestApprovalParams | Approve skill execution |
| `item/tool/call` | DynamicToolCallParams | Dynamic tool call |
| `account/chatgptAuthTokens/refresh` | ChatgptAuthTokensRefreshParams | Refresh auth tokens |

## Approval Response Format

```json
// For command execution approval
{
  "id": <rpc_id>,
  "result": {
    "decision": "allow" | "deny" | "always_allow",
    "acceptSettings": { "forSession": true }
  }
}
```

## turn/start Input Format

```json
{
  "threadId": "thread-abc123",
  "input": [
    { "type": "text", "text": "Fix the login bug" },
    { "type": "image", "url": "https://..." },
    { "type": "localImage", "path": "/path/to/screenshot.png" }
  ],
  "model": "o3",
  "effort": "high",
  "cwd": "/path/to/workspace",
  "approvalPolicy": "on-request",
  "sandboxPolicy": {
    "type": "workspaceWrite",
    "writableRoots": ["/path/to/workspace"],
    "networkAccess": true
  },
  "collaborationMode": {
    "mode": "...",
    "settings": {
      "model": "...",
      "reasoning_effort": "medium",
      "developer_instructions": "..."
    }
  }
}
```

## thread/list sourceKinds

Threads have source metadata indicating where they originated:
- `cli` — created from CLI
- `vscode` — created from VS Code extension
- `appServer` — created from app-server client
- `subAgentReview` — sub-agent for code review
- `subAgentCompact` — sub-agent for context compaction
- `subAgentThreadSpawn` — sub-agent spawned thread
- `unknown` — unknown source

Internal sub-agent threads (e.g., memory consolidation) can be filtered from UI by excluding `subAgent` from sourceKinds.

## Session Storage

- **Location**: `$CODEX_HOME/sessions/` (default: `~/.codex/sessions/`)
- **Format**: JSONL transcript files
- **Naming**: `*-{sessionId}.jsonl`
- **Nested**: Files may be in subdirectories

## FalconDeck Compatibility Assessment

### What app-server provides that FalconDeck needs:

| FalconDeck Requirement | App-server Coverage |
|---|---|
| Spin up sessions | `thread/start` |
| Monitor agents | All notification events (streaming deltas, turn lifecycle) |
| Fast thread switching | `thread/list`, `thread/resume` |
| Code review | `review/start` |
| Approval handling | Server-initiated `requestApproval` methods |
| Multiple agents in same folder | `thread/start` with same `cwd` on multiple threads |
| Session persistence | Built-in (JSONL in CODEX_HOME) |
| Model selection | `model/list` |
| Interrupt/cancel | `turn/interrupt` |
| Turn steering | `turn/steer` (inject input during running turn) |

### What FalconDeck needs beyond app-server:

| Need | Solution |
|---|---|
| Multiple simultaneous agents | Spawn multiple app-server processes, one per workspace (CodexMonitor pattern) OR multiple threads in one process |
| Mobile sync | Wrap app-server events in relay protocol (Happy pattern) |
| Claude Code support | Separate integration via Claude Agent SDK (different protocol) |
| Unified event model | Translation layer between Codex notifications and Claude SDK events |

### Rust compatibility

App-server communicates via stdio JSON-RPC. Rust can natively:
- Spawn `codex app-server` as a subprocess via `tokio::process::Command`
- Read/write newline-delimited JSON via `tokio::io::BufReader`
- Correlate request/response by monotonic `id` using `HashMap<u64, oneshot::Sender>`
- Parse notifications by `method` field using serde discriminated unions

CodexMonitor's Rust implementation (`app_server.rs`) proves this works at production scale with 1000+ line Rust implementation handling the full protocol.

### Key implementation note

The auto-generated TypeScript types from `codex app-server generate-ts` can be used as a reference to create equivalent Rust types via serde. The protocol includes both v1 (legacy conversation-based) and v2 (modern thread-based) APIs. FalconDeck should target v2 only.

# Connectors (MCP servers)

Connectors give your agents tools: MCP servers that FalconDeck passes to every
provider it spawns — Claude, Codex, and any ACP provider — from one shared
config. Configure a server once and every agent in the workspace can use it.

## Configuration

Two files, merged by server name (workspace wins):

- `~/.falcondeck/connectors.json` — applies to every workspace on the machine
  (on a remote host: every workspace on that server).
- `<workspace>/.falcondeck/connectors.json` — applies to one workspace; commit
  it if the whole team should share it (keep secrets in the global file or in
  env-var references your servers resolve themselves).

The format is the de-facto standard `mcpServers` map, so entries copy-paste
straight from any MCP server's README:

```json
{
  "mcpServers": {
    "linear": {
      "command": "npx",
      "args": ["-y", "@linear/mcp-server"],
      "env": { "LINEAR_API_KEY": "lin_api_…" }
    },
    "docs": {
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    },
    "experimental": {
      "command": "my-server",
      "enabled": false,
      "providers": ["claude"]
    }
  }
}
```

Per-server optional fields:

- `enabled: false` — park an entry without deleting it.
- `providers: ["claude", "codex", "opencode", …]` — offer the server only to
  the listed provider ids. Default: all providers.

## Behavior

- Config is re-read at each spawn boundary (every Claude turn, every Codex
  app-server start, every ACP session), so edits apply on the next turn — no
  daemon restart.
- Materialization per provider: Claude gets a `--mcp-config` file (written
  0600 into the daemon's private state dir, since env blocks often hold API
  keys); Codex gets `-c mcp_servers.*` config overrides; ACP providers get the
  `mcpServers` array in `session/new`.
- `url`-based (HTTP) servers currently reach Claude only; Codex and ACP
  materialization is stdio-only and skips them with a log line.
- A malformed file is logged and treated as empty — it never takes the daemon
  or a turn down.
- Remote hosts work identically: the files live on the server the daemon runs
  on.

The desktop app edits this same file visually: **Settings → Connectors** —
server list with per-scope chips, enable toggles, an add-server form, and
paste-JSON import. The composer shows a plug chip with the count of servers
available to the current workspace. Remote daemons expose the same config over
the encrypted `connectors.read` / `connectors.update` RPCs.

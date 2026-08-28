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
- Materialization per provider, ranked so FalconDeck's list is what the
  spawned CLI sees without rewriting the user's own config files:
  - ACP: `mcpServers` on `session/new`.
  - OpenCode native: `OPENCODE_CONFIG_CONTENT` env overlay on `opencode
    serve` (merges on top of the user's `opencode.json`; does not edit that
    file).
  - Claude: a per-launch `--mcp-config` file (0400 in the daemon's 0700
    state dir, unique name, unlinked when the turn ends) plus
    `--strict-mcp-config`. An empty `{"mcpServers":{}}` is written when
    nothing is configured so the user's global Claude MCP servers cannot
    leak in.
  - Codex: `-c mcp_servers.*` overrides, including Streamable HTTP `url`
    plus `bearer_token_env_var` so tokens are not on the argv, and
    `tool_output_token_limit=25000`.
- Spawned CLIs also get `MCP_TIMEOUT=30000`, `MCP_TOOL_TIMEOUT=10800000`
  (3h), and `MAX_MCP_OUTPUT_TOKENS=25000` so long connector results are not
  truncated.
- HTTP servers reach Claude, Codex, and ACP agents that advertise
  `mcpCapabilities.http`.
- The desktop **Plugins** view is a ChatGPT-style directory: Plugins and
  Skills as top-level tabs, an Installed row, then Featured plus category
  lists. OAuth servers are signed in once by the daemon; the access token
  lives in `~/.falcondeck/connector-oauth.json` (0600) and is injected as
  `Authorization: Bearer` at spawn. API-key servers (GitHub PAT, fal,
  Context7) store the key in `connectors.json` headers. Harnesses do not run
  their own OAuth login.
- Plugin logos are cached under `~/.falcondeck/cache/logos` (0600). The daemon
  fetches from [logo.dev](https://www.logo.dev/) when
  `FALCONDECK_LOGO_DEV_TOKEN` (or `LOGO_DEV_PUBLISHABLE_KEY`) is set, otherwise
  a public favicon fallback, and rechecks about once a month. First-fetch
  timestamps are staggered per domain so a full catalog does not expire on the
  same day.
- Codex MCP servers can pause a turn with `mcpServer/elicitation/request`.
  URL-mode prompts (Cloudflare sign-in and similar OAuth) become a Continue /
  Cancel card with a clickable link; form-mode prompts reuse the question
  card, including Decline. FalconDeck answers Codex with
  `{ "action": "accept" | "decline", "content"? }` so the app-server turn does
  not stall. Accept on a URL prompt means the user consented to open the
  link — the MCP server still finishes the out-of-band flow on its own.
- A malformed file is logged and treated as empty — it never takes the daemon
  or a turn down.
- Remote hosts work identically: the files live on the server the daemon runs
  on.

## Security model

Connector commands are spawned by the agent CLIs **outside** FalconDeck's
approval and sandbox machinery — configuring a connector is configuring code
that runs as you. The files are only writable by your user (0600), the
loopback API is protected against browser-origin and DNS-rebinding access, and
**paired devices can edit connectors over the encrypted relay channel**:
pairing a device means trusting it with your machine (it can already drive
agent turns with any permission mode). Remote connector/provider edits emit a
visible service notice so they never happen silently. Revoke a device in
Settings → Remote Access if you no longer trust it.

The desktop app edits this same file visually: **Settings → Connectors** —
server list with per-scope chips (global plus project workspaces; casual chats
inherit global servers and are not listed), enable toggles, an add-server form,
and paste-JSON import. The composer shows a plug chip with the count of servers
available to the current workspace. Remote daemons expose the same config over
the encrypted `connectors.read` / `connectors.update` RPCs.

The same panel also renders inside the sidebar's **Plugins** view (MCP servers
section), which pairs it with the skills library — see `docs/PLATFORM.md` §5
for the skills install/browse surface and its `/api/skills*` endpoints.

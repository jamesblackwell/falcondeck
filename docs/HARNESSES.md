# Harnesses (coding CLI management)

FalconDeck orchestrates coding harnesses (Codex, Claude Code, OpenCode, …)
but does not ship them. The harness manager gives clients a uniform,
API-driven way to answer "what is installed where, is it current, and can
you fix it?" — locally and on SSH hosts — so upgrade prompts and MCP install
flows can be offered anywhere in the conversation lifecycle, not just in
settings.

- Daemon implementation: `crates/falcondeck-daemon/src/app/harness_manager.rs`
- Protocol types: `HarnessSummary` & friends in `crates/falcondeck-core/src/lib.rs`,
  mirrored in `packages/client-core/src/types.ts` with normalizers in
  `packages/client-core/src/normalization.ts`
- Desktop UI: Settings → Harnesses (`apps/desktop/src/components/settings/HarnessesPanel.tsx`)

## Inventory model

An overview is a list of `HarnessSummary` entries for one host:

| Field | Meaning |
| --- | --- |
| `id` / `label` / `kind` | Identity; `kind` is `builtin` (codex, claude), `acp` (providers.json entry), or `detected` (known CLI found on the machine) |
| `bin` / `resolved_path` / `installed` | Binary name and canonical path (npm symlinks resolve into `node_modules`) |
| `version` | Parsed from `<bin> --version` (first `x.y` token) |
| `latest_version` / `update_available` | Populated only by an explicit refresh with update checks enabled |
| `install_source` | Best-effort classification: npm / homebrew / cargo / local / unknown |
| `upgrade_command` | Present only for curated, managed harnesses |
| `account_status` | Auth/subscription line for harnesses with a probe (`codex login status`, `claude auth status`) |

Entries come from two sources, merged by id:

1. **Curated registry** (`KNOWN_HARNESSES` in `harness_manager.rs`): codex,
   claude, opencode, gemini, pi, zcode. Each entry declares its npm package
   (for latest-version lookups), upgrade command, and optional auth probe.
   Adding a harness means adding one struct — the panel, RPC, and per-host
   probing pick it up automatically.
2. **`providers.json` ACP entries**: overlaid on the curated list (matching
   ids switch to `kind: acp` and probe the configured command), and appended
   as new entries otherwise. Custom entries are listed with status but never
   auto-upgraded (`upgrade_command: null`).

## API surface

Local (axum, loopback-only like the rest of the daemon API):

| Route | Purpose |
| --- | --- |
| `GET /api/harnesses` | Cached overview for the local machine (60s TTL) |
| `POST /api/harnesses/refresh` | Re-probe; body `{ ssh_target?, port?, include_latest? }`. With `ssh_target`, probes that host instead |
| `POST /api/harnesses/upgrade` | Start install/upgrade job; body `{ harness_id, ssh_target?, port? }` → `{ job_id }` |
| `GET /api/harnesses/jobs/{job_id}` | Poll job status (`running` / `completed` / `failed`, with log lines) |

Remote (relay-bridged encrypted RPC): `harnesses.read`, `harnesses.refresh`,
`harnesses.upgrade`, `harnesses.job`. Registered in `REMOTE_RPC_METHODS` and
`dispatch_remote_rpc` in `crates/falcondeck-daemon/src/app/remote_bridge.rs`;
the binding test there fails to compile if the two drift apart.

Per AGENTS.md, protocol changes start in `falcondeck-core` and
`client-core`; the daemon and all clients read the same shapes.

## Probing

- **Local:** binaries resolve through `agent_binary.rs` (configured path →
  PATH → known locations → login-shell `command -v`). Version and auth probes
  run concurrently per harness, each capped at 15s, and only when the binary
  exists.
- **SSH hosts:** one BatchMode `ssh` invocation batches every bin probe
  (`command -v`, `--version`, auth) using `FD_BIN:` / `FD_VER:` /
  `FD_AUTH:` / `FD_MISSING:` markers parsed with `splitn(3, ':')` so paths
  containing colons survive. The ssh exec helpers are shared with host
  provisioning (`host_provisioning.rs`), including target validation that
  rejects anything ssh could read as flags.
- **Latest versions:** `include_latest` (default true on refresh) fetches
  `registry.npmjs.org/<package>/latest` per managed harness, concurrently,
  15s cap. This is the only network call in the module and it never runs
  during snapshots or on a timer — on-demand only, per product decision.

## Upgrades

- Upgrade commands come **exclusively from the curated registry** — never
  from client input. `harness_id` is validated against the registry and
  entries without an `upgrade_command` (e.g. zcode, custom ACP agents) are
  rejected with a clear error.
- Local upgrades run through `$SHELL -l -c "<command>"` so the user's
  login-shell PATH resolves `npm` / `curl` (the packaged macOS daemon does
  not inherit the terminal PATH). 600s ceiling, output appended to the job
  log.
- Remote upgrades run the same command string as a single BatchMode ssh
  script with the same ceiling.
- Jobs are in-memory only (like provisioning jobs): meaningless across a
  daemon restart, pruned after 32 retained entries.
- On start and on completion the host's cache entry is invalidated so the
  panel never serves a pre-upgrade answer.

## Client notes

- The desktop panel keys hosts as `"<sshTarget>:<port>"` ( `"local"` for
  this Mac) and re-probes on host switch. Job polling mirrors the
  provisioning panel (1.5s interval, stops on terminal status, re-probe
  after completion).
- Use the `normalizeHarnessesOverview` / `normalizeHarnessUpgradeJob`
  helpers from `@falcondeck/client-core`; they tolerate partial daemon
  responses and older daemons (missing fields become null).
- Cross-harness MCP configuration is **not** part of this module: connectors
  already inject MCP servers into codex TOML overrides, Claude
  `--mcp-config`, and ACP `session/new`. Harness management should stay
  install/version-shaped; MCP shape stays in `connectors.rs`.

## Extending

- **New curated harness:** add a `KnownHarness` entry (id, bin, npm package
  for update checks, upgrade command, optional auth probe). No other
  registration needed.
- **New probe type** (e.g. subscription usage quotas): extend
  `HarnessSummary` in `falcondeck-core` **and** `client-core` (type +
  normalizer), then populate it in `probe_local_harness` /
  `remote_probe_script`. Remember remote probes must stay shell-safe and
  marker-parsed.
- **Background update checks:** deliberately not built. If product wants
  them, add a TTL'd scheduler around `apply_latest_versions` rather than
  calling it from snapshot paths.

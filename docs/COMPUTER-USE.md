# Computer use: embedding cua-driver in FalconDeck

Status: Phase 1 implemented, 2026-09-03. Phase 2–3 remain planned.

Goal: a FalconDeck user installs the app, grants two macOS permissions to
FalconDeck once, and every agent in every harness can drive native apps on
that Mac in the background. No second app, no CLI install, no PATH, no
`cua-driver skills install`.

This plan pins **cua-driver-rs v0.23.2** (released 2026-08-31, tag
`cua-driver-rs-v0.23.2` in `trycua/cua`). The local
`~/.local/bin/cua-driver` on the dev Mac is 0.2.0 and the skill copies in
`~/.agents/skills`, `~/.claude/skills` and this repo's `.agents/skills` are
the old Swift-era skill. None of them should be used as a source.

## 1. What was verified

Facts below come from the Cua repo docs (`libs/cua-driver/rust/Skills/cua-driver/EMBEDDING.md`,
`docs/content/docs/reference/cua-driver/{embedding,process-model,permission-modes,telemetry}.mdx`),
the Rust `EmbeddedCuaDriverHost` source (`crates/cua-driver-sdk/src/embedded.rs`),
and a smoke test of the 0.23.2 universal binary run from inside a FalconDeck
agent turn.

### Cua's embedding contract

- macOS TCC attributes Accessibility and Screen Recording to the
  **responsible process** at the top of the launch chain, not to a binary
  path. A child spawned with `posix_spawn`/`fork`+`exec` inherits the host
  app's grants. `open -a` / `NSWorkspace` breaks the chain.
- Embedded mode is `cua-driver serve --embedded` (or `CUA_DRIVER_EMBEDDED=1`,
  exact value). It disables the driver's own responsibility-disclaim re-exec
  and its `open -a CuaDriver` relaunch, never prompts, and reports
  `check_permissions.source.attribution = "host"`.
- The host spawns one long-lived `serve` daemon on a private Unix socket.
  Each MCP client runs `cua-driver mcp --embedded --socket <path>` as a thin
  stdio proxy; the proxy never executes tools.
- The reference Rust host launches:
  `serve --embedded --parent-liveness-stdio --no-permissions-gate --socket <p> --host-bundle-id <id> --permission-mode standard [--no-overlay]`,
  with `env_clear()` plus an allowlist (`PATH HOME USER LOGNAME SHELL TMPDIR TMP TEMP LANG LC_*`)
  and `CUA_DRIVER_EMBEDDED_HOST_PID`. Stdin is the parent-liveness pipe: EOF
  shuts the daemon down (confirmed: stdin from `/dev/null` exits immediately).
  Readiness is a metadata handshake on the socket, 10 s timeout.
- MCP proxy invocation the host should hand to agents:
  `<bin> mcp --embedded --socket <p> --host-bundle-id com.falcondeck.desktop`, empty env.
- `health_report({"include":["bundle_identity"]})` resolves the daemon's
  **direct parent** as an app. Smoke test from a zsh parent: `bundle_identity`
  = fail, "Process has no CFBundleIdentifier". The daemon must be spawned
  directly by the `falcondeck-desktop` executable, never through `sh -c`.
- TCC answers are cached per process. After a grant changes, restart the
  driver child. TCC rows are keyed to the code-signing identity; re-signing
  the app (ad-hoc dev builds) orphans the rows. Recovery:
  `tccutil reset Accessibility com.falcondeck.desktop && tccutil reset ScreenCapture com.falcondeck.desktop`.
- Permission modes are fixed for the daemon lifetime: `standard` (default,
  promptless routine automation, denies OS-prompt raising, requires a launch
  grant to attach to an existing logged-in Chromium profile), `bounded`
  (requires a capability manifest), `unrestricted` (needs two-part dangerous
  acknowledgement). Agent tool calls can never change the mode.
- Telemetry is on by default (PostHog EU, content-free, pseudonymous install
  id). Override with `CUA_DRIVER_RS_TELEMETRY_ENABLED=false`. The GitHub
  update check on `serve`/`mcp` startup is separate:
  `CUA_DRIVER_RS_UPDATE_CHECK=false`.
- Requires macOS 14+. FalconDeck's `minimumSystemVersion` is 12.0.
- The `--claude-code-computer-use-compat` flag is effectively dead (its
  screenshot tool was removed upstream). Use the plain `cua-driver` surface
  for every harness.

### Release assets (tag `cua-driver-rs-v0.23.2`)

| Asset | Use |
| --- | --- |
| `cua-driver-rs-0.23.2-darwin-arm64.tar.gz`, `-darwin-x86_64.tar.gz` | per-arch `cua-driver` binary (plus `CuaDriver.app`, dylib, node runtime we do not need) |
| `cua-driver-rs-0.23.2-darwin-universal-binary.tar.gz` | 62 MB universal `cua-driver`, Developer ID signed by Cua AI (team `YCK386LBJ7`), hardened runtime, links only system frameworks |
| `cua-driver-rs-v0.23.2-skills.tar.gz` | skill pack: `SKILL.md MACOS.md BROWSER.md RECORDING.md README.md EMBEDDING.md WINDOWS.md LINUX.md`, `version: 0.23.2` in frontmatter |
| `checksums.txt`, `release-manifest.json` | sha256 for every asset |

Binary and skill must always come from the same tag so the tool surface the
skill describes matches the binary.

### Smoke test result on the dev Mac

Running `serve --embedded ...` from a FalconDeck agent turn (responsible
process `/Applications/FalconDeck.app/Contents/MacOS/falcondeck-desktop`):

- `tcc_accessibility` pass, `tcc_screen_recording` pass. FalconDeck.app
  already holds both grants on this Mac (Accessibility from dictation setup).
- Idle RSS of the `serve` daemon: about 240 MB. Do not start it at app
  launch; start it lazily.
- `cua-driver call check_permissions --socket` hung for 10 s; `call health_report`
  answered immediately. Use `health_report` as the host's status probe.

### FalconDeck facts that shape the design

- In the packaged app the daemon runs **in-process** inside
  `falcondeck-desktop` (`apps/desktop/src-tauri/src/lib.rs:499`,
  `spawn_embedded`). A child spawned by daemon code is a direct child of the
  app executable, so the TCC chain and the `bundle_identity` check are both
  satisfied without moving the supervisor into the Tauri crate.
- Headless `falcondeck-daemon` (remote hosts, SSH) has no app identity and
  must never spawn the driver.
- Builtin MCP connectors are code-defined and never persisted:
  `connectors.rs` `BuiltinConnectors { control, extensions }`,
  `with_builtin_servers`, composed per spawn in `app.rs:1234`
  `builtin_connectors(provider, workspace_path, thread_id)`. Every harness
  (Codex `-c mcp_servers.*`, Claude leased `--mcp-config`, ACP `session/new`,
  OpenCode `OPENCODE_CONFIG_CONTENT`, Pi via the extension bridge) picks a
  third builtin up with zero per-harness work.
- Bundled skills are `include_str!` bodies staged atomically into
  `~/.falcondeck/skills/<name>/SKILL.md` by `agent_context.rs`
  `stage_bundled_skills`; Codex gets the directory via `skills/extraRoots/set`,
  Claude and ACP get "read on demand" path lines from `append_instructions`.
- Sidecar precedent: `bundle.externalBin: ["binaries/deno"]`,
  `scripts/prepare-extension-runtime.mjs` (pinned version, sha256 verified,
  `--download` in CI), `bundled_deno_bin()` in `lib.rs:463`,
  `DaemonConfig.deno_bin`. The release workflow re-signs whatever Tauri
  bundles with FalconDeck's Developer ID and notarizes.
- Permission FFI precedent: `dictation.rs` extern block +
  `macos_dictation.m` (`fd_dictation_request_accessibility_permission`,
  `fd_dictation_accessibility_permission`, `fd_dictation_open_accessibility_settings`),
  Tauri commands `dictation_permission_status` / `request_dictation_permission`,
  and `DictationSetup.tsx` which re-polls at 600 ms and 1800 ms after a request.
- Capability negotiation: `DaemonCapabilities { scheduled_tasks }` in
  `crates/falcondeck-core/src/lib.rs:42`. Currently one flag.
- Env applied to every harness: `MAX_MCP_OUTPUT_TOKENS=25000`, Codex
  `tool_output_token_limit=25000`. Full AX snapshots can be ~190 KB.
- `packages/chat-ui` already renders `content.kind === "image"` in tool
  results (`message.tsx:1813`); needs verification per harness.

## 2. Critique of the earlier notes

Keep:

- One app, two grants, driver inherits. Correct and the whole point.
- Builtin connector injected at spawn, never written to `connectors.json`.
- Stage the release-matched skill the way `falcondeck-control` is staged.
- Never `open -a CuaDriver`; never model it as a harness.
- Desktop-local capability; remote daemons can't inherit.

Change:

- "Spawn from Tauri, not from `falcondeck-daemon`." This misreads the
  packaged architecture: the daemon is in-process, so daemon code spawning
  the child *is* FalconDeck.app spawning it. Put the supervisor in the daemon
  crate behind `DaemonConfig.computer_use_bin` (set only by the desktop
  embedding). That keeps socket path, connector injection and health in one
  place. The Tauri crate only contributes the binary path and the permission
  FFI. Verify with `health_report` `bundle_identity`, which the smoke test
  shows failing when a shell sits between app and daemon.
- "Update the driver independently of the app version." Not for a binary
  nested in a signed, notarized bundle: replacing it breaks the bundle seal.
  Pin per FalconDeck release like deno (`CUA_DRIVER_VERSION` in a prepare
  script), bump deliberately, and ship binary + skill from the same tag. An
  out-of-bundle override directory is a later phase, not the default.
- "Add AX/Screen Recording to Info.plist/entitlements." There are no plist
  keys for those; they are TCC prompts triggered by API calls. What is
  actually needed: `com.apple.security.automation.apple-events` entitlement
  and `NSAppleEventsUsageDescription` (Cua uses Apple Events for some app
  operations; hardened runtime denies them without the entitlement).
  Accessibility is already requested by the dictation code; reuse it.
- "Per-turn `cua-driver mcp` spawned by FalconDeck." The harness spawns the
  proxy from the connector spec; FalconDeck only supplies the command line.

Missing from the notes, now covered below: opt-in and kill-switch UX, the
permission mode choice, telemetry and update-check env, screenshot payloads
in transcripts synced to phones, macOS 14 gate, dev-signing TCC churn, the
25 k token cap versus AX snapshots, the stale skill copies, lazy start.

## 3. Architecture

```text
FalconDeck.app  (com.falcondeck.desktop, Developer ID signed)
  falcondeck-desktop process
    ├─ embedded falcondeck-daemon (in-process)
    │    └─ ComputerUseHost supervisor
    │         └─ cua-driver serve --embedded --socket ~/.falcondeck/computer-use/cua-<pid>-<gen>.sock
    ├─ codex app-server / claude / acp agent (children)
    │    └─ cua-driver mcp --embedded --socket <same>   (spawned by the harness from the connector spec)
    └─ Tauri commands: permission status / request / open settings
```

- Binary: `Contents/MacOS/cua-driver` via `externalBin`, re-signed with
  FalconDeck's identity at bundle time.
- Permission mode: `standard`. No `unrestricted` anywhere in the product.
  `bounded` manifests are a later option for Missions and scheduled tasks.
- Connector name: `cua-driver` (Cua's canonical server name, so the skill's
  tool references and Cua docs match what agents see).
- Start policy: lazy. The daemon starts on the first spawn boundary where
  computer use is enabled and both grants are present, stays up, and stops
  with the daemon. Idle shutdown after inactivity can come later.
- Env for `serve`: `env_clear()` + Cua's allowlist +
  `CUA_DRIVER_EMBEDDED=1`, `CUA_DRIVER_HOST_BUNDLE_ID=com.falcondeck.desktop`,
  `CUA_DRIVER_RS_UPDATE_CHECK=false` (FalconDeck owns updates),
  `CUA_DRIVER_RS_TELEMETRY_ENABLED=<user setting>`.
- Availability = desktop embedding AND macOS ≥ 14 AND binary present.
  Enabled = availability AND user switched it on AND both grants present.
  The connector and skill are injected only when enabled and the driver is
  healthy. Never inject a broken tool surface.

## 4. Phases

### Phase 0: hygiene (no product code)

- `git rm -r .agents/skills/cua-driver` (Aug 19 Swift-era skill, commit
  421a08d) and the copy under `.claude/worktrees/mobile-snapshot-perf/`.
- On the dev Mac: remove `~/.agents/skills/cua-driver` and
  `~/.claude/skills/cua-driver`, then either uninstall the 0.2.0
  `CuaDriver.app` + `~/.local/bin/cua-driver` or reinstall 0.23.2 via the
  release `install.sh` for terminal use. The standalone app is unrelated to
  the embedded path either way.

### Phase 1: bundled computer use (MVP)

**Build pipeline**

- `scripts/prepare-computer-use-runtime.mjs`, modelled on
  `prepare-extension-runtime.mjs`: `CUA_DRIVER_VERSION = "0.23.2"`, pinned
  sha256 per asset from `checksums.txt`; download the per-arch darwin
  tarball for `--target`, extract only `cua-driver`, write
  `apps/desktop/src-tauri/binaries/cua-driver-<triple>`, chmod 755. A
  `--skills` mode downloads `cua-driver-rs-v<ver>-skills.tar.gz`, verifies,
  and refreshes the checked-in
  `crates/falcondeck-daemon/src/agent_context/cua-driver/` (`SKILL.md`,
  `MACOS.md`, `BROWSER.md`, `RECORDING.md`, `README.md`, plus a `VERSION`
  file). One script, one tag, no drift.
- `tauri.conf.json`: `externalBin: ["binaries/deno", "binaries/cua-driver"]`;
  `.gitignore`: `binaries/cua-driver-*`; `beforeBuildCommand` and
  `.github/workflows/release-desktop.yml` run the new prepare step with
  `--download`.
- `entitlements.plist`: add `com.apple.security.automation.apple-events`.
  `Info.plist`: add `NSAppleEventsUsageDescription`. Confirm notarization
  still passes with the re-signed nested binary (deno already proves the
  path).
- DMG grows by roughly 30 MB per arch.

**Tauri (`apps/desktop/src-tauri`)**

- `bundled_cua_driver_bin()` next to `bundled_deno_bin()` (`lib.rs:463`);
  `DaemonConfig.computer_use_bin: Option<String>` passed at `lib.rs:499`.
- `macos_computer_use.m` + extern block in a new `computer_use.rs`:
  accessibility status/request (call the existing dictation functions),
  screen recording status via `CGPreflightScreenCaptureAccess`, request via
  `CGRequestScreenCaptureAccess`, open the Screen Recording pane
  (`x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture`),
  macOS version check. Tauri commands `computer_use_permission_status`,
  `request_computer_use_permission`, `open_computer_use_settings`, registered
  in `generate_handler!`. `build.rs` already links ApplicationServices.

**Daemon (`crates/falcondeck-daemon`)**

- `computer_use.rs`: `ComputerUseHost` mirroring Cua's Rust host: generation
  id, `prepare_endpoint` (refuse live sockets, remove stale ones), direct
  `tokio::process::Command` spawn with the flags above, stdin held as the
  liveness pipe, stdout/stderr to the daemon log, socket-ready + `health_report`
  handshake with 10 s timeout, `start()` coalescing, `stop()`, `restart()`,
  `wait_for_exit`. Health probe = `cua-driver call health_report --socket <p>`
  with `include: ["bundle_identity","tcc_accessibility","tcc_screen_recording","ax_capability","screen_capture_capability"]`.
  Constructed only when `DaemonConfig.computer_use_bin` is `Some`; the
  standalone dev daemon may read `FALCONDECK_CUA_DRIVER_BIN` (terminal
  attribution, dev only).
- `connectors.rs`: `BUILTIN_COMPUTER_USE_CONNECTOR_NAME = "cua-driver"`,
  `BuiltinComputerUseSpec { binary, socket_path }`,
  `builtin_computer_use_server()` returning
  `McpTransport::Stdio { command: binary, args: ["mcp","--embedded","--socket",p,"--host-bundle-id","com.falcondeck.desktop"], env: {} }`,
  a third field on `BuiltinConnectors`, handled in `with_builtin_servers`
  (user connectors named `cua-driver` are dropped with a warning like the
  other reserved names). `AppState::builtin_connectors` (`app.rs:1234`)
  lazily starts the host and returns the spec only when ready.
- `agent_context.rs`: stage the `cua-driver` skill directory into
  `~/.falcondeck/skills/cua-driver/` (same tmp+rename refresh) when computer
  use is enabled; `append_instructions` gains one line, only when the
  connector is injected: the `cua-driver` MCP server can operate apps on
  this Mac in the background without stealing focus; read
  `<path>/SKILL.md` and `MACOS.md` first; use its MCP tools, not the CLI.
- Preferences (daemon-side, host-local): `computer_use.enabled`,
  `computer_use.telemetry`, `computer_use.overlay`.
- API + relay RPC (all four dispatchers per `docs/PLATFORM.md`):
  `GET /api/computer-use` (available, enabled, macos_ok, permissions,
  driver_version, generation, last health), `POST /api/computer-use`
  (settings), `POST /api/computer-use/restart`, `POST /api/computer-use/test`
  (health + a screenshot of a FalconDeck window, returned as a thumbnail).
- `DaemonCapabilities.computer_use: bool` so remote-web and mobile hide the
  feature for hosts that don't have it. Client-core types and normalizer
  updated.
- Transcript payloads: cap or thumbnail image blocks from tool results
  before they go into session files, the snapshot and the mobile cache
  (previous 5 MB snapshot incident applies). Verify image blocks render in
  chat-ui for Codex, Claude and ACP tool results.

**Desktop UI**

- Settings → "Computer use" (`settings-utils.ts` section id + nav entry,
  `SettingsView.tsx` branch, `ComputerUsePanel.tsx` on the packages/ui
  settings primitives). Contents: hero switch; two permission rows
  (Accessibility, Screen Recording) with Grant buttons that request, then
  re-poll like `DictationSetup`, and an "Open System Settings" fallback for
  the case where macOS refuses to raise the Screen Recording prompt;
  "Test it" (runs the test endpoint, shows the thumbnail); driver version;
  Restart driver; telemetry toggle; cursor overlay toggle; unsupported
  states (macOS < 14, remote host).
- Onboarding: new step "Let agents use your Mac" after Dictation
  (`ONBOARDING_STEPS`/`ONBOARDING_STEP_INDEX` in `OnboardingWizard.tsx`),
  reusing a shared `ComputerUseSetup` component; skippable; fixture params in
  `onboarding-qa.tsx`. Enabling computer use is the act of completing this
  step, so the switch defaults off until a human has seen the prompt. The
  compact layout offers Restart FalconDeck; the wizard persists the current
  step id (`falcondeck.desktop.onboarding.resume.v1`) so a relaunch for TCC
  returns to this step instead of Welcome. Completing or rerunning setup
  clears that resume.
- Grant-change handling: when the panel observes a grant flip, call
  restart; if `screen_recording` is true but the test screenshot is black,
  offer "Restart FalconDeck" (`restart_app` exists).

### Phase 2: trust and polish

- "Controlling your Mac" indicator in the activity view while a
  `cua-driver` tool call is in flight, with a Stop that cancels the turn and
  runs `cua-driver revoke --all` on the socket. Optional global panic hotkey
  alongside the dictation shortcut.
- "Allow agents to use my signed-in browser profile" setting →
  `--grant existing-profile` on the next daemon start (requires restart;
  explain in UI).
- macOS 15+ periodic screen-capture re-consent dialog: detect via a failed
  test capture and show a one-line explanation rather than a generic error.
- Per-connector output token limit if AX snapshots keep tripping the 25 k
  cap (or rely on the skill's filtering guidance and measure first).
- Mobile: surface the settings summary and permission state read-only; the
  connector already works for threads started from the phone.

### Phase 3: later

- Out-of-bundle driver channel: download a newer Developer-ID-signed
  `cua-driver` into `~/.falcondeck/computer-use/releases/<ver>/`, verify
  sha256 from `release-manifest.json`, prefer it over the bundled binary.
  TCC is unaffected because the responsible process is still FalconDeck.app.
  Only worth it if Cua's cadence outpaces desktop releases in practice.
- Linux remote hosts: cua-driver-rs runs on X11 with no TCC story; would
  need a headless-safe supervisor and a Linux binary in the remote install.
- `bounded` capability manifests for Missions and scheduled tasks
  (deny-by-default tool and app allowlists, lifetimes).
- Windows desktop when FalconDeck ships there (same daemon-proxy shape).

## 5. Decisions to confirm

1. Opt-in switch (recommended) versus auto-enable once grants exist.
2. Cua telemetry default inside FalconDeck: recommended off with a toggle,
   since FalconDeck users never saw Cua's installer notice.
3. Lazy start (recommended, 240 MB idle) versus start at launch.
4. Onboarding step in Phase 1 (recommended; it is the "just works" moment)
   versus settings-only first.
5. Whether screenshots in tool results are persisted full-size, thumbnailed,
   or dropped from session files after the turn.

## 6. Risks

- Hardened-runtime re-signing of a third-party binary: deno proves the
  pipeline, but cua-driver touches ScreenCaptureKit and AppKit; test the
  notarized build, not a dev build.
- Dev builds are ad-hoc signed; every rebuild can orphan the TCC rows
  (same class as the keychain wedge in 7fb68b9). Document the `tccutil reset`
  recipe and prefer a stable signing identity for local packaged builds.
- Screenshots of the user's desktop enter transcripts that sync to phones
  through the relay and persist in session files. Prompt injection from
  screen content is real; `standard` mode plus harness tool approvals is the
  floor, the Phase 2 indicator and stop are the ceiling.
- Two threads driving the desktop at once is allowed by Cua and chaotic for
  the user. Acceptable for MVP; consider a per-host lease later.
- `call check_permissions` hung in the smoke test; if it reproduces in the
  embedded host, stick to `health_report`.

## 7. Verification checklist

- Packaged, notarized build launches offline with no CuaDriver.app installed
  and no `cua-driver` on PATH.
- System Settings → Privacy & Security lists only FalconDeck under
  Accessibility and Screen & System Audio Recording.
- `health_report`: `bundle_identity` pass with
  `identity_source = parent_application`, bundle id `com.falcondeck.desktop`;
  `check_permissions.source.attribution = host`.
- Background `get_window_state` of a Finder window returns a tree and an
  image without Finder coming to the front.
- Codex, Claude, an ACP agent and Pi each list the `cua-driver` tools in a
  thread and can click something in TextEdit.
- A thread started from the mobile app can do the same on the Mac.
- Revoke Screen Recording in System Settings → panel flips to "needs
  permission" → re-grant → driver restarts → test passes.
- Remote host daemon reports `computer_use: false`; the panel shows the
  unsupported state; no connector is injected for remote threads.
- `tccutil reset` recipe restores a working state on a dev build.

# Desktop onboarding

> Status: **Phase 1 implemented** (2026-08-17, extended 2026-09-02) — flag +
> gating (`shouldShowFirstRunOnboarding`), `OnboardingWizard` (welcome /
> appearance / dictation / optional OpenRouter speech key / tools / project /
> finish), rerun control in Settings → General, browser fixture at
> `/onboarding-qa.html`, and the client-core harness methods (`harnesses`,
> `refreshHarnesses`, `upgradeHarness`, `harnessUpgradeJob`). Phases 2–4
> below remain planned. The OpenRouter step in the wizard is the **speech**
> secret (`/api/speech/openrouter-key`) for read-aloud, voice rewrite, and
> cloud transcription — not the still-planned OpenCode provider key.
>
> The Mac app is the entry point into FalconDeck for most new users. A fresh
> install opens this wizard once the daemon is ready. Every step is skippable;
> Skip setup marks onboarding complete so it does not nag again.

## Product shape

A full-window overlay on first launch, stepped like a native macOS setup
assistant. Every step is skippable; the whole flow is skippable. Rough
sequence:

1. **Welcome** — brand moment, one sentence on what FalconDeck is.
2. **Choose your appearance** — System/Light/Dark, named light and dark
   themes, interface/chat/code fonts, and text size. Same device-local
   `fd-appearance` record as Settings → Appearance; fine-tune stays in
   Settings.
3. **Dictate on this computer** — enable system-wide dictation, pick a
   shortcut (Right Command and fn are suggested; any other key or chord can
   be recorded), hold/toggle mode, optionally enable voice rewrite and its
   shortcut. Apple Speech is the zero-key default. Microphone, engine, and
   rewrite prompt stay in Settings → Speech.
4. **Optional: OpenRouter** — one speech key on this computer unlocks
   read-aloud, voice rewrite, and cloud transcription. Continue skips it.
5. **Check your tools** — probe installed harnesses (Claude Code, Codex,
   OpenCode, Gemini, Pi), show version / update / sign-in state, offer
   one-click install and update.
6. **Add your first project** — directory picker → `connectWorkspace`.
7. **Finish** — request notification permission explicitly.

The OpenCode + OpenRouter *provider* quick path (install OpenCode, register
the agent, store `OPENROUTER_API_KEY` for models) is still Phase 2 and is a
different secret from the speech key.

Later phases add recommended OpenCode plugin installs (e.g. the image-vision
plugin so screenshots work with non-vision models) and extension/MCP
suggestions once that UI layer exists.

## What already exists (the plan leans on all of this)

The detection and install substrate is essentially done; onboarding is mostly
a UI that sequences existing daemon capabilities.

| Capability | Where | Notes |
| --- | --- | --- |
| Harness inventory | `crates/falcondeck-daemon/src/app/harness_manager.rs` | Curated `KNOWN_HARNESSES` (codex, claude, agy, opencode, pi, grok, cursor) + `providers.json` ACP overlay; 60s cache |
| Probe endpoints | `GET /api/harnesses`, `POST /api/harnesses/refresh` (`include_latest` hits npm registry) | Also relay RPCs `harnesses.read/refresh/upgrade/job` |
| Install/upgrade | `POST /api/harnesses/upgrade` → job, poll `GET /api/harnesses/jobs/{id}` | Commands come only from the curated registry (OpenCode = `curl -fsSL https://opencode.ai/install \| bash`); `HarnessesPanel.tsx` already implements the polling UI |
| Binary resolution + diagnostics | `crates/falcondeck-daemon/src/agent_binary.rs` | PATH, known locations, login shell; `ResolutionDiagnostics` supports "we looked here" messaging |
| Recommended agents | `apps/desktop/src/components/settings/AgentsPanel.tsx` (`RECOMMENDED_AGENTS`) | One-click add of OpenCode/Pi entries to `providers.json` via `PUT /api/providers` |
| Secret storage precedent | `crates/falcondeck-daemon/src/app/speech.rs` + `storage.rs` secret file | OpenRouter key for speech: validate-on-save, daemon-host-only per decision D15 (`docs/06-architecture-decisions.md`) |
| Overlay/dialog pattern | `apps/desktop/src/components/ResumeStoppedThreadsDialog.tsx` | Hand-rolled `fixed inset-0` + `role="dialog"`; no Dialog primitive exists in `@falcondeck/ui` yet |
| Device-local prefs tier | `apps/desktop/src/preferences.ts`, localStorage `falcondeck.desktop.*` keys | Where the onboarding flag belongs |
| App updater | `apps/desktop/src/hooks/useAppUpdater.ts` | Initial check fires 15s after startup — must be sequenced with onboarding |

Client-side, `packages/client-core` already has `HarnessSummary` /
`HarnessesOverview` types and normalizers — but no client methods and no
exports; `HarnessesPanel` raw-`fetch`es. Onboarding should close that gap
rather than add a third copy.

## Design

### Gating and the completed flag

- **Storage:** device-local localStorage, key `falcondeck.desktop.onboarding.v1`,
  value `{ completedAt, skipped, wizardVersion }`. Not daemon preferences:
  onboarding is per-install UX, resetting it must not touch shared daemon
  state, and remote-web clients pointed at an established daemon should never
  see it. Matches the existing device-local tier (zoom, shortcuts, appearance).
- **Show when:** running under Tauri (`isTauriDesktop()`), flag absent, and
  the daemon connection is ready. `AppInner` currently ignores
  `connectionState` from `useDaemonConnection` — onboarding needs to consume
  it so the wizard opens against live data, not a connecting spinner.
- **Sequencing:** while the wizard is open, suppress the
  `ResumeStoppedThreadsDialog` offer and hold the updater's initial 15s check
  (or at least its UI) until the wizard closes. Notification permission is
  requested by the wizard itself, not lazily mid-flow.
- `wizardVersion` lets a future major release re-run a "what's new" variant
  without a second mechanism.

### Rerun for testing (requirement)

Settings → General, bottom of the panel, deliberately low-key: **"Show
onboarding at next launch"**. Clicking it deletes the localStorage key and
toasts confirmation. Nothing else is touched — projects, threads, keys, and
daemon state all survive; quitting and relaunching replays the wizard as a
new user would see it.

This forces a property the wizard needs anyway: **every step is idempotent
and reads live state**. A harness already installed renders as a green check,
a key already stored renders as "already configured", an existing project
list renders the project step as "add another or continue". Rerunning on a
fully-set-up machine should be a pleasant 30-second review, not an error
farm.

For UI iteration without a Tauri rebuild, `apps/desktop` also ships
`/onboarding-qa.html` (`npm run dev` in that package). It mounts the real
wizard against a mocked harness inventory; `?step=`, `?theme=`,
`?workspaces=`, and `?baseUrl=` jump around. Appearance and dictation writes
hit this browser's localStorage, same keys as the app.

### Step 2 — Choose your appearance

Reuse `ThemeControls` and `TypographyControls` from `@falcondeck/ui` so
onboarding and Settings → Appearance update the same device-local
`fd-appearance` record. Mode, palette, font, and text-size changes apply
immediately; the per-surface fine-tune matrix stays in Settings. No
onboarding-only draft state or extra completion write is needed.

### Step 3 — Check your tools

On entry: `POST /api/harnesses/refresh { include_latest: true }` (network
lookups are on-demand only, by existing product decision — this is the
moment they're wanted). Render a card per curated harness:

- **Installed + current** → check, version.
- **Installed + `update_available`** → "Update" button → upgrade job + poll.
- **Not installed** → "Install" button (same job API) where the registry has
  an upgrade command.
- **Sign-in state** — `account_status` today is a raw truncated string and
  only codex/claude have auth probes at all. Phase 1 renders it as best-effort
  text plus a copyable sign-in command (`claude` / `codex login` — auth flows
  are interactive and terminal-owned, the app cannot complete them) and a
  "Check again" button. A structured `Ready/NeedsAuth/Unknown` verdict on
  `HarnessSummary` is a phase-2 daemon improvement.

If nothing is installed, the step's primary CTA routes to step 4.

### Step 4 — OpenCode + OpenRouter quick path

Three sub-actions, each independently skippable and idempotent:

1. **Install OpenCode** — existing upgrade-job API.
2. **Register the agent** — write the `providers.json` entry, reusing the
   `RECOMMENDED_AGENTS` add logic from `AgentsPanel` (extract it into a
   shared helper rather than duplicating).
3. **OpenRouter API key** — masked input, validate-on-save, link to
   openrouter.ai/keys. Storage follows decision D15: a **new daemon secret**
   (e.g. `providers.openrouter-api-key`) in the same secret store as the
   speech key — *not* `providers.json` `env`, which is a plaintext JSON file.
   The daemon injects `OPENROUTER_API_KEY` into the OpenCode subprocess
   environment at spawn (both native and ACP transports), with explicit
   `providers.json` env still winning. A checkbox "also use this key for
   voice dictation" writes the speech secret too, so one key lights up both
   features.

Daemon work for (3): a small module modeled on `speech.rs` (routes
`GET/PUT/DELETE /api/providers/openrouter-key`, relay RPC mirrors, cache,
validate-on-save against the OpenRouter API), plus the env-injection hook in
`opencode_threads.rs` / `acp.rs` spawn paths.

### Step 6 — Finish

- Request macOS notification permission via the existing
  `request_macos_notification_permission` command — today this happens lazily
  on the first attention notification, which means the permission dialog
  interrupts the user's first real agent turn. Asking here, with context, is
  strictly better.
- Summary card of what was configured; primary button closes the wizard,
  writes the flag, and focuses the composer (with the first project selected
  if one was added).

### UI construction

- New lazy view/overlay (working name `OnboardingOverlay`) rendered at the
  app root beside `ResumeStoppedThreadsDialog`, above `DesktopShell` — not a
  `main-view-registry` entry, since it must cover the whole window including
  the sidebar. Window chrome is `titleBarStyle: Overlay`, so the welcome
  layout needs traffic-light clearance.
- Add a minimal `Dialog`/overlay primitive to `packages/ui` while we're here
  (three hand-rolled copies exist already), or at minimum extract the
  `ResumeStoppedThreadsDialog` pattern. Step chrome (progress dots, back/next)
  is bespoke to onboarding.
- Add harness methods (`harnesses()`, `refreshHarnesses()`,
  `upgradeHarness()`, `harnessUpgradeJob()`) to
  `packages/client-core/src/daemon-client.ts` and export the `Harness*`
  types; migrate `HarnessesPanel` onto them opportunistically.
- Visual bar is high: this is the first thing every new user sees. Budget for
  a real brand moment on the welcome step, not a grey card.

### Copy note

`docs/EXTENSIONS.md` reserves the word "plugin" against FalconDeck's own
extension system. OpenCode's plugins are genuinely called plugins, so UI copy
must always qualify: "OpenCode plugin", never bare "plugin".

## Phase 4 (later) — Recommended OpenCode plugins

Goal: offer curated OpenCode plugins during onboarding, starting with
image-vision (gives screenshot support to models without native vision):

```json
"plugin": [
  [
    "@showlotus/opencode-image-vision",
    { "model": "<vision-capable model id>", "timeout": 120000 }
  ]
]
```

FalconDeck currently never reads or writes OpenCode's own config
(`~/.config/opencode/opencode.json`) — OpenCode fully owns it. Native
OpenCode sessions get FalconDeck connectors through the
`OPENCODE_CONFIG_CONTENT` env overlay (runtime merge, no file edit). Options
for *OpenCode plugins* (not MCP connectors) remain:

- **A. Merge-write the user's global opencode.json** (recommended): daemon
  endpoint that reads, backs up, and merges the plugin entry if absent.
  Invasive but honest — the plugin then works in OpenCode's own TUI too.
  Requires explicit per-plugin consent in the wizard.
- **B. `OPENCODE_CONFIG` pointing at a FalconDeck-managed file** — rejected
  as default: it *replaces* config discovery, silently disabling an existing
  user's own opencode.json.

Also in this phase: default model choice for the vision plugin (tied to the
OpenRouter key from step 3), and possibly a structured auth verdict + an
`opencode auth`-based probe in `KNOWN_HARNESSES` (verify what OpenCode's CLI
actually offers first).

## Phasing

| Phase | Scope | Daemon changes |
| --- | --- | --- |
| 1 | Flag + gating, rerun control in Settings → General, welcome, appearance, harness check step (install/update/auth-text), first project, notifications + finish, client-core harness methods | None |
| 2 | OpenCode quick path: provider entry one-click + OpenRouter key secret with env injection; structured auth verdict on `HarnessSummary` | New secret route + spawn env injection; probe enum |
| 3 | Polish: `wizardVersion` re-run variant, Grok in `KNOWN_HARNESSES`, richer diagnostics ("we looked in…") | Small |
| 4 | OpenCode plugin recommendations (image-vision), extension/MCP suggestions once the extensions UI layer lands | opencode.json merge endpoint |

## Testing

- Vitest: gating logic (flag present/absent, non-Tauri, connection not
  ready), rerun-reset control, per-step idempotency against a mocked daemon
  client, sequencing (resume dialog + updater suppressed while open).
- Rust: secret route round-trip, `OPENROUTER_API_KEY` injection precedence
  (secret < providers.json env), upgrade-job flow already covered.
- Manual: `/onboarding-qa.html` is the UI loop (no Tauri rebuild). The
  Settings → General rerun control is the packaged-app loop — reset, relaunch,
  walk the wizard on a fully-configured machine and on a clean one
  (`FALCONDECK_STATE_PATH` + scratch `HOME` for the latter).

## Open questions

1. Harness sign-in can't complete inside the app (interactive CLI flows). Is
   "copy this command, run it in Terminal, then Check again" acceptable for
   v1, or do we embed a terminal pane?
2. Should "Skip" mark onboarding complete (never nags again, rerun control
   available) — proposed yes — or re-offer once on next launch?
3. Which vision-capable model to default the image-vision plugin to, and
   whether the model id should track the OpenRouter catalog dynamically.
4. Does mobile eventually get a matching moment (it already has the pairing
   screen as de-facto onboarding), and should desktop's finish step point at
   phone pairing?

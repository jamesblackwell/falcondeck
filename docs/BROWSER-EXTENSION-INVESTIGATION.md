# Agent browser extension investigation

2026-10-30. Investigation only; no browser or product configuration changed.

## Recommendation: add alongside

Add an **opt-in extension browser for signed-in, interactive work**. Keep
cua-driver for native apps and the isolated agent browser for research, localhost
QA, and tasks that should not inherit James's personal accounts. Do not replace
cua-driver or silently move agents into the personal profile.

The main benefit is simpler access to existing logins and independently owned
tabs. Our current isolated profile already avoids Chrome's remote-debugging
consent prompt. An extension removes the need to launch and own that extra
Chrome for authenticated tasks; it does not inherently improve page semantics,
prevent prompt injection, or make an asleep Mac run agents.

Start with a bounded evaluation of Playwright MCP extension mode before owning
a new browser engine. If it meets background-operation and permission requirements,
wrap/reuse it; otherwise build a small FalconDeck bridge using its patterns.
Neither vendor's proprietary browser integration is a documented, general-purpose
backend for every FalconDeck harness.

## What others ship

Sources below were read on October 30, 2026. Product behavior is distinguished
from proposed FalconDeck behavior; no competitor was installed or tested here.

**Claude in Chrome.** Claude Code connects to the extension, uses existing
logins, and puts task tabs in a session group. Its browser tool surface covers
DOM/console inspection, navigation, input, screenshots, uploads, and recordings.
Chrome and Edge are supported, with detection for other Chromium browsers.
The CLI installs a native-messaging manifest; current troubleshooting also names
`bridge.claudeusercontent.com`, so “extension plus native messaging” is not a
complete description of every connection path. Direct Anthropic sign-in is
required; API-key and third-party-provider authentication do not enable it.
Site permissions come from the extension, with mode-dependent overrides.
Documented failures include native-host discovery, idle service workers, and
account/organization mismatches. [Claude Code Chrome documentation](https://code.claude.com/docs/en/chrome)

The extension itself offers browser permissions and a visible control surface;
its requested permissions include native messaging. This is substantial access
to a signed-in browser, rather than an isolated automation account.
[Claude in Chrome setup and permissions](https://support.claude.com/en/articles/12012173-get-started-with-claude-in-chrome)

**OpenAI.** The current ChatGPT browser extension supports Chrome, Edge, Brave,
Opera, and Vivaldi, with tab mentions and control from the desktop app in Work
or Codex chats. It reuses signed-in sites. Website access defaults to asking for
new hosts; users can allow once, persist access, or maintain allow/block lists.
The public page does not establish the low-level transport or a supported
third-party MCP integration. [Browser extension documentation](https://learn.chatgpt.com/docs/chrome-extension)

There is also a separate built-in browser with its own profile and sign-ins;
it is not available in Codex CLI or the IDE extension. Thus OpenAI itself offers
both profile models. [Built-in browser documentation](https://learn.chatgpt.com/docs/browser)
Atlas has retired and no longer receives updates; it is not the current
standalone browser to imitate. [Atlas retirement](https://help.openai.com/en/articles/20001371-chatgpt-atlas-retirement)

**Playwright MCP extension mode.** `--extension` connects to existing
Chrome/Edge/Chromium sessions. Users approve a connection and pick a tab; a
profile-specific token can bypass repeated approval. Multiple clients get
separate groups and see only their group's tabs; a tab belongs to one client.
A profile selector avoids accidental connection to the last-used profile.
[Extension README](https://github.com/microsoft/playwright/blob/main/packages/extension/README.md)
Its source explicitly handles worker restart cleanup and rejects a tab already
connected elsewhere. Initial connection activates the tab and focuses its
window: stock behavior needs evaluation against FalconDeck's background-use
requirement. [Background implementation](https://github.com/microsoft/playwright/blob/main/packages/extension/src/background.ts)

**BrowserMCP.** The current repository describes an MCP proxy, one local daemon,
Playwright, and a `chrome.debugger` extension relay over loopback. Pairing uses
a matching code and popup approval; the extension enforces Stop and restricted
tab rules independently. This is close to FalconDeck's desired ownership model.
Its Chromium dependency excludes Firefox. The repository is Apache-2.0;
modified distributions need distinct branding.
[BrowserMCP source and architecture](https://github.com/BrowserMCP/mcp)

**browser-use.** Its documented real-browser mode selects an existing Chrome
profile and warns Chrome may need to close first. Its browser infrastructure
also exposes CDP. It is useful automation prior art, but these sources do not
establish an extension-based solution to our ownership problem.
[Real browser guide](https://docs.browser-use.com/open-source/customize/browser/real-browser),
[browser infrastructure](https://browser-use.com/developers)

An extension and CDP are not opposites: Chrome's `debugger` extension API is
another transport for restricted CDP domains, targeted by tab. It requires a
powerful debugger permission. [Chrome debugger API](https://developer.chrome.com/docs/extensions/reference/api/debugger)

## Comparison for FalconDeck

The extension column describes the recommended design, not a claim that every
existing extension implements these controls.

| Concern | Current cua / named isolated Chrome | Optional extension in user's browser |
| --- | --- | --- |
| Login reuse | Persistent separate cookies; James signs in separately | Existing site sessions; no cookie copying |
| Consent and setup | No personal-profile prompt in default flow; executable discovery and profile ownership still matter | Store install, pairing, site grants; debugger permission/indicator if using that API; no remote-debugging-port setup |
| Page reliability | Semantic snapshots, scoped refs, CDP input and screenshots already exist | Can reuse Playwright snapshots/input through debugger relay; stale refs, frames, canvas, and navigation races remain |
| Background use | CDP can inspect/capture a bound tab without focus; some trusted input routes refuse hidden tabs | DOM/CDP can avoid focus; initial setup, browser UI, dialogs and trusted input must be verified |
| Several agents | One shared named profile has exclusive launch ownership; ending its session closes the process | One group and exclusive tab lease per thread; disconnect only that lease; shared cookies/account state still race |
| Security boundary | Separate account exposure, but everything signed into agent profile remains reachable | Much larger account exposure; enforce site, tab and command limits at bridge and extension |
| Chrome closed | Driver can launch isolated Chrome; current guidance also launches personal Chrome to pin executable and avoid Dock routing surprises | Extension cannot execute while its browser/profile is shut; explicit launch or clear unavailable status required |
| Idle / locked / asleep | Native capture/input may depend on unlocked GUI; CDP can work without foreground | DOM/CDP may work locked while Chrome and daemon remain running; no guarantee for native dialogs/screenshots; sleep stops both |
| Install/update | Already bundled, pinned and supervised with FalconDeck | One-time store install per profile plus host pairing; store auto-updates require protocol version negotiation |
| Browsers | Typed browser route is Chromium; native-app route remains available elsewhere | Chromium first; Edge/Brave need host registration/testing; Firefox and Safari need separate work |

Chrome 136 stopped honoring remote-debugging switches for the default data
directory unless a nonstandard user-data directory is supplied. This differs
from the later personal-profile consent UI observed on this Mac. Do not
“fix” either by weakening browser settings.
[Chrome's remote-debugging restrictions](https://developer.chrome.com/blog/remote-debugging-port)

Extension transport does not remove power-management concerns. MV3 workers
normally stop after inactivity; Chrome documents native connections and active
WebSocket traffic among lifecycle mechanisms. Reconnection must survive worker,
browser, and daemon restarts. [Worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)
Our `apps/desktop/src-tauri/Info.plist` already disables App Nap because hidden
FalconDeck disk I/O caused remote RPC timeouts. That setting is not a guarantee
about Chrome, macOS lock, or sleep. Test each separately before promising
unattended operation.

## What agents hit locally

Read-only skim of `~/.claude/projects/**/*.jsonl` and
`~/.codex/sessions/**/*.jsonl`: records dated October 23–30 UTC through scan time
on October 30. Candidate files were selected by modification time (256 Claude,
345 Codex), then records by timestamp. This is a local-machine sample across
projects, not fleet telemetry or a clean comparison before/after the October 27
profile change. No page text, URLs, credentials, or raw transcripts are included.

Claude: deduplicated direct cua MCP `tool_use` IDs, paired `tool_result`s.
415 calls/results: 210 state reads, 94 clicks, 64 navigations, 25 prepares,
22 typing calls. Thirty results matched explicit error/refusal flags or known
failure codes. Codex: recognized literal `tools.mcp__cua_driver__…(` calls
inside `exec` records, excluded compaction replacement histories, deduplicated
wrapper call IDs. Found 322 calls in 309 wrappers with matched outputs across
23 files: 179 reads, 48 navigations, 45 prepares, 34 clicks, 13 file inputs,
3 typing calls. Dynamic dispatch, CLI calls, interrupted calls and errors
without recognizable codes can be missed.

| Observed failure | Claude result count | Codex code occurrences |
| --- | ---: | ---: |
| `browser_route_unavailable` (setup/launch/route failure) | 11 | 4 |
| `browser_endpoint_owner_mismatch` | 4 | 9 |
| `browser_consent_required` | 2 | 14 |
| Wrong target / consent did not settle | 1 | 4 |
| `browser_input_trust_unavailable` | 4 | 0 |
| `browser_ref_stale` | 3 | 1 |
| `browser_binding_stale` / `browser_binding_ambiguous` | 0 | 3 |
| `browser_action_unavailable` | 2 | 1 |
| Ended session reused | 2 | Not classified |
| Scoped query without `semantic_v2` | 1 | Not classified |

Counts are rough: Claude assigns one category per failed result; Codex counts
explicit codes in wrapper output, which can batch calls or repeat messages.
Do not add the columns into a failure rate. A refusal can be correct security
behavior, and a successful call does not prove the task succeeded. Zero means
not observed by this parser. In particular this sample cannot count hangs that
never returned, login interruptions, or App Nap incidents reliably.

The memories explain the failure classes, without proving every logged cause:

- October 27 profile notes: personal-CDP consent spam; named-profile ownership
  conflicts; sign-in Chrome singleton blocking driver launch; abrupt session
  end closing Chrome before cookies flush; another automation Chrome capturing
  Dock/link launches. The shared named profile trades isolation from James
  for contention between agents.
- September browser-selection note: Chrome bundle attestation fell through to
  Edge unless agents supplied the right Chrome PID. This records an older
  driver version; it is history, not a new diagnosis of this installation.
- October 21 orphan note: a sidecar retained FalconDeck's LaunchServices
  identity after its parent died, blocking normal app launch. An extension
  browser would not eliminate this while native cua remains enabled.
- `docs/COMPUTER-USE.md` records a patched browser snapshot ancestry cycle and
  a 120-second watchdog that exits the helper. A transport swap alone would
  not repair the same snapshot algorithm; a different engine might avoid it.

Local evidence: the four memory files named in the investigation request,
`docs/COMPUTER-USE.md`, the staged cua `SKILL.md`, `BROWSER.md`, and
`FALCONDECK.md`. The older computer-use memory predates implementation;
the current repo document and staged version 0.33.4 take precedence.

## Proposed architecture

```text
Codex / Claude CLI / ACP / other harness
                 | builtin MCP connector, bound to thread identity
                 v
FalconDeck daemon: BrowserHost
  grants + tab leases + bounded commands + deadlines + status/stop
                 | private Unix socket, authenticated local connection
                 v
signed native-messaging shim (Chrome starts this process)
                 | length-prefixed JSON over stdin/stdout
                 v
Chrome MV3 extension: service worker + popup/status
                 | tab-scoped debugger relay / content scripts
                 v
explicitly granted tabs, grouped by FalconDeck thread

Existing ComputerUseHost -> cua-driver -> native apps / isolated Chrome
```

Prefer native messaging for shipping: Chrome launches the shim, the manifest
allows only the release extension ID, and the shim connects to the existing
daemon rather than starting a second product daemon. Register the host through
explicit desktop setup and keep its path stable across updates. Chunk images
and bound messages; Chrome limits messages from the host to 1 MB.
[Native messaging contract](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
A localhost WebSocket is simpler for a spike but needs pairing, short-lived
credentials, strict extension-origin checks, loopback binding and rejection of
arbitrary web origins. Loopback alone is not authentication.

Reuse builtin connector injection across harnesses, daemon-owned approval and
settings flows, bundled skill staging, tool/image rendering, and process-health
patterns. Start any shared wire types in core/client-core. Do not give models
raw debugger commands: expose prepare/list granted tabs, snapshot, navigate,
click/type/scroll, screenshot, and release. Add uploads/downloads only with
explicit file authority. Reuse Playwright's engine where practical instead of
reimplementing semantic snapshots in Rust.

Enforce exclusive tab leases using server-supplied thread identity, not a
caller-selected label. Keep document generations on refs; revoke leases on
user removal, disconnect or navigation out of scope. Never let one thread's
cleanup quit Chrome or close another thread's tabs. Groups are an ownership UI,
not cookie/account isolation. Serialize conflicting workflows or use isolated
profiles for independent accounts.

Keep origin grants and a global Stop in the extension as well as daemon checks.
Check navigation destinations, redirects, popups and frame origins; do not
read disallowed content before asking. Deny browser-internal pages, other
extensions, incognito and file URLs by default. Separate localhost grants.
Debugger authority is broader than ordinary host permissions, so extension
checks must constrain it too. `activeTab` alone is insufficient for unattended
multi-site tasks because it requires a user gesture and loses access across
origins. [Chrome activeTab semantics](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)

Treat page content as untrusted data. Allowlists reduce exposure, but a trusted
site can host injected instructions and leak data through an allowed action.
Retain action approvals for consequential operations and minimize transcript
captures. These policies bound the browser bridge; they do not sandbox a
full-access coding agent that also has shell/network tools.

FalconDeck's own extension system is a separate concept. `docs/EXTENSIONS.md`
provides agent-tool registration and status-panel possibilities, but not a
shipping privileged browser/native-messaging host contract. Put transport and
security in a first-party daemon capability; optionally expose status through
the existing extension UI. Do not broaden third-party Deno permissions just to
host this bridge. No conversation database is needed.

## Effort and decision criteria

Engineering estimates, not measured commitments; one experienced engineer:

| Scope | Estimate |
| --- | --- |
| Disposable evaluation of stock Playwright extension: two agents, grants, background actions, reconnect | 2–4 working days |
| First-party Mac/Chrome MVP: bridge, pairing/setup, leases, bounded tools, status/Stop and focused tests | 3–5 engineering weeks total, including evaluation |
| Hardened release: redirects/frames, file flows, restart/update recovery, security review, packaging and Chromium variants | 6–10 engineering weeks total; store review time additional |

Largest unknowns are debugger contention with DevTools/other extensions,
trusted input in hidden tabs, cross-origin frames and popups, service-worker
recovery without replaying writes, store approval for debugger permissions,
and stable native-host paths through FalconDeck updates. Browser version and
OS lock/sleep behavior need live tests; this investigation deliberately did
not run them.

Proceed beyond evaluation only if two concurrent threads cannot reach each
other's tabs, releasing either leaves the other's tabs and logins intact,
new origins require grants, Stop revokes access immediately, and reconnect
fails safely after an uncertain write. Verify idle, locked, closed-browser,
and sleeping-Mac behavior separately. If stock Playwright cannot meet those
requirements without a large fork, keep the isolated browser default while
scoping the small first-party bridge. The extension is a useful additional
access path, not grounds to discard the working native automation stack.

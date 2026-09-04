# FalconDeck In-App Browser

| Field | Value |
| --- | --- |
| Status | Draft |
| Date | 2026-09-03 |
| Author | FalconDeck design |
| Audience | Desktop, daemon, and client-core engineers |
| Related | `docs/BB-SIDE-CHATS-AND-BROWSER.md`, `docs/COMPUTER-USE.md`, `docs/EXTENSIONS.md`, `docs/PLATFORM.md`, `docs/17-desktop-code-review.md`, `DESIGN.md` |

## Overview

FalconDeck currently hands every `http(s)` link to the system browser (`apps/desktop/src/external-links.ts` → `openExternalUrl` in `apps/desktop/src/api.ts` → Tauri `open_external_url` in `apps/desktop/src-tauri/src/lib.rs`). There is no in-app browsing surface. The product intent is that FalconDeck owns a real multi-tab browser, used **by default**, so users stay in the agent workspace instead of bouncing to Chrome.

This is **not** computer-use and **not** an agent browser tool. Computer-use (`docs/COMPUTER-USE.md`) embeds `cua-driver` so agents can drive the user's real Chrome/Safari, including a signed-in profile. Extension sandboxed webviews (`docs/EXTENSIONS.md`, `docs/PLATFORM.md`) are a later trusted-UI escape hatch. The in-app browser is a third, user-facing surface: FalconDeck's own WKWebView tabs, with FalconDeck-owned cookie profiles.

v1 is a shippable desktop browser: one persistent FalconDeck profile, one **shared** incognito session, multi-tab chrome in the right rail, default in-app routing for ordinary `http(s)` links, and the security policy (app ACL, private-network rules, popup-to-tab) in place **before** those links hit a child webview. Chrome cookie import, per-project profiles, and agent control are later phases.

v1 does **not** claim "start logged in on the sites you already use." Users can keep a FalconDeck-owned session for sites that accept embedded WebKit (often GitHub via top-level redirects). Google-class IdPs reject embedded WKWebView OAuth (`disallowed_useragent`). The reliable signed-in Chrome identity remains computer-use / Open in System Browser.

## Background & Motivation

### Current state

- Desktop intercepts `<a href>` clicks in capture phase so the Tauri app webview never navigates away (`installExternalLinkHandler`). `shouldHandleClick` currently ignores `metaKey` / `altKey` and intercepts primary and middle clicks.
- `openExternalUrl` / `open_external_url` allow only `https:`, `mailto:`, and `tel:`. `http:` is rejected at both the TS (`api.ts` `isSafeExternalUrl`) and Rust (`is_safe_external_url`) openers. Chat markdown still *resolves* `http:` via `resolveExternalHref`.
- Connector OAuth (`PluginsView.tsx`) and remote pairing (`RemotePairingPopover.tsx`) call `openExternalUrl` directly and **bypass** the click interceptor. They must stay on that path; the in-app router must never wrap `openExternalUrl` itself.
- Main-webview CSP sets `frame-src 'none'` (`apps/desktop/src-tauri/tauri.conf.json`). That CSP is not a sandbox for child webviews; it only forbids iframes in `main`.
- Tauri capabilities list `"windows": ["main", "activity", "dictation"]` (`apps/desktop/src-tauri/capabilities/default.json`). There is **no** `apps/desktop/src-tauri/permissions/` tree, so FalconDeck has no app ACL manifest. Plugin commands are gated; app-defined commands are not, for local origins.
- Hardened Runtime already includes WebView JIT (`entitlements.plist` `com.apple.security.cs.allow-jit`) and **microphone** (`com.apple.security.device.audio-input`) for dictation.
- Global shortcuts are a `document` `keydown` listener in `App.tsx`. There is no `NSEvent` local monitor.
- The right rail is a **review workspace** (`docs/17-desktop-code-review.md`): `DiffPanel` / `FileListView` tabs `info | changes | files`. Default hidden (`usePanelVisibility`, `falcondeck.desktop.panels.v1`). `⌥⌘B` (`toggleChanges`) toggles the **whole rail**. `DesktopShell` hardcodes one rail: `id="rail"`, `defaultSize="25%"`, `minSize="280px"`, `contentWidth="280px"`. `ResizableSidePanel` freezes `defaultSize` at mount.
- Command palette actions in `packages/chat-ui` are a closed prop set (`onOpenSettings`, `onOpenActivity`, …). There is no `extraActions` hook.
- `lib.rs` registers a process-wide `on_web_content_process_terminate` that `reload()`s **every** webview label.
- Remote web opens links with `window.open(..., "noopener,noreferrer")`. Mobile uses `Linking.openURL`.
- Existing host→webview events use the `falcondeck://` prefix (`falcondeck://dictation-state`, `falcondeck://activity-state`).

### Why now

- Chrome already has its own agent skills/plugins. Handing every docs/GitHub/PR link to Chrome fights the "stay in FalconDeck" loop.
- Computer-use will drive *the user's Chrome*. That is the right path for "use my real logged-in browser under agent control." It is the wrong path for "I clicked a link in a task and want to read it next to the transcript."
- BB shipped a desktop-only Electron `WebContentsView` browser as a secondary-panel tab with one isolated `persist:bb-browser` session (`docs/BB-SIDE-CHATS-AND-BROWSER.md`, local checkout `/Users/James/www/sites/bb`). FalconDeck is Tauri 2.11.5, not Electron; the equivalent is a child `WKWebView`, not `WebContentsView`.

### Pain points

- Context switch on every citation, docs link, or PR URL.
- No FalconDeck-owned browsing session independent of Chrome (with the IdP caveats above).
- No throwaway isolated session (incognito) without leaving the app.

## Goals & Non-Goals

### Goals

- Ship a **user-facing** in-app browser on **desktop macOS 14+**.
- Default: ordinary `http(s)` links from chat, the command palette, and the address bar open in FalconDeck — only after the security policy in [Navigation policy](#navigation-popups-downloads-permissions) is in the same binary.
- Multi-tab chrome good enough that people will actually browse in-app.
- First-class **profile / cookie** model, even if v1 only ships two profiles.
- Keep conversation visible while browsing.
- Preference to send links back to the system browser.
- Explicit, honest story for Chrome cookie import **and** for embedded-WebView login limits.

### Non-goals (v1)

- Agent control of in-app tabs (later phase; sketch only). Do not add `DaemonCapabilities.browser_automation` now.
- Computer-use / `cua-driver` / driving real Chrome (`docs/COMPUTER-USE.md`). The in-app WKWebView is not a cua-driver target.
- Extension UI webviews (`docs/EXTENSIONS.md`).
- Embedding untrusted pages in the main Tauri webview (iframes are forbidden by CSP).
- Remote-web or mobile native browser.
- Becoming a general-purpose Chromium: no extensions, no Chrome sync, no password manager import, no PDF chrome beyond WKWebView defaults.
- Windows / Linux. Desktop is macOS-first; the native manager should be trait-shaped so WebView2 can land later, but v1 is WKWebView only.
- Raising `minimumSystemVersion` (currently 12.0). The *feature* gates on macOS 14 because `WKWebsiteDataStore(forIdentifier:)` does. The gate is in **Rust** `browser_attach`, not only in React.
- Silent Chrome/Safari cookie scrape; Google login inside the embedded view.

## Key Decisions

1. **Desktop-shell feature, not a daemon feature.** Native `WKWebView` cannot live in `falcondeck-daemon`. v1 state (tabs, profiles, preference) is device-local. The daemon does not grow browser RPCs, profile lists, or a conversation DB of URLs. Protocol crates stay untouched until a later agent-control phase.

2. **Tauri multiwebview (`unstable` + `Window::add_child`), not iframes, not Electron, not a second `WebviewWindow`.** Untrusted pages load in child webviews of `main`. Chrome (tab strip, address bar) is React in the existing app webview. Placement is renderer-measured bounds, same pattern as BB. `macos-private-api` is already enabled; the Cargo change is adding `unstable`.

3. **Install an app ACL manifest and scope capabilities to trusted webview labels before the first child webview.** Two gates, not one:
   - **Plugin commands** (`core:default` includes `core:webview:allow-get-all-webviews` and `allow-internal-toggle-devtools`): Tauri 2 applies a `windows: ["main"]` capability to *every* webview in that window. Switch to `"webviews": ["main", "activity", "dictation"]` and omit `windows`.
   - **App-defined commands** (`open_external_url`, `read_host_session_secret` / `write_host_session_secret`, `open_local_path`, `read_local_text_file`, dictation, computer-use permission commands, …): FalconDeck has **no** app ACL manifest today. Tauri 2.11.5 (`webview/mod.rs` ~1819–1852) skips ACL for those commands when `!has_app_acl_manifest && is_local`. Remote `https://` children already cannot invoke them unless a `remote` capability is added (we will never add one). The hole is a child that loads a **local** origin (`http://localhost:1420` is `devUrl` and `is_local_url`; `tauri://localhost` / `http(s)://tauri.localhost` are the prod protocol). User-typed loopback is otherwise allowed for local dev servers, so this is not hypothetical.
   PR 1 therefore uses **two** capabilities, not an invented subset:
   - **`default`:** every command that `main` / `activity` / `dictation` already invoke, on `"webviews": ["main", "activity", "dictation"]`. Today those three labels share one capability; keep that. Activity (`ActivityWindow.tsx`) calls `focus_main_window` and `open_external_url`. The dictation overlay (`DictationOverlay.tsx`) calls the whole `dictation_*` surface from the `dictation` webview. Splitting those onto `main` only would break those windows the moment `has_app_acl_manifest` flips.
   - **`browser`:** `browser_*` allows on `"webviews": ["main"]` only (stubbed in PR 1, filled in PR 3).
   Never add `remote` URLs. Adding *any* app permission file flips `has_app_acl_manifest` and **every** custom command starts requiring an explicit allow — the first capability must list the full current surface or the app breaks. Do not claim "child not in capabilities" stops custom commands until that manifest exists.

4. **Rail surface switcher, not a new FileListView tab and not a conversation takeover.** The right rail gains two surfaces: **Review** (existing diffs/files) and **Browser**. Browser tabs live in browser chrome. Switching tasks does not destroy browser tabs. Conversation stays in the center column. `⌥⌘B` continues to hide/show the **whole rail**; it does not switch Review ↔ Browser.

5. **v1 profiles: `falcondeck` (persistent, app-wide) and one shared `incognito` session.** Persistent tabs share a `data_store_identifier`. Incognito tabs share **one manager-owned `WKWebsiteDataStore::nonPersistentDataStore()`**. For each incognito tab, create a **fresh** `WKWebViewConfiguration`, `setWebsiteDataStore(shared_store)`, then `with_webview_configuration(that_copy)`. Never reuse one `WKWebViewConfiguration` `Retained` across two `add_child`s: wry treats `webview_configuration.is_some()` as `using_existing_config` and would re-`addUserScript` Tauri IPC glue plus re-register `webkit.messageHandlers.ipc` on the shared `WKUserContentController`, undoing `harden_child` on the first tab. Calling `incognito(true)` per webview is also **not** enough: wry maps that to a **new** `nonPersistentDataStore()` each time. Per-project / per-thread profiles are v2+. Isolated per-tab cookies are a future "this tab only" profile, not v1 incognito.

6. **Chrome cookie import is not v1, and may never be a silent Keychain scrape.** Chrome 127+ uses app-bound encryption on macOS. Passwords, localStorage, and open tabs are never imported. Computer-use remains the path to "my real Chrome, already signed in." v1 persistence is "sites that accept embedded WebKit, after you sign in here" — not Google, not "the sites you already use."

7. **In-app is the default for ordinary `http(s)` links; system browser is one click / one preference / ⌘-click away.** `mailto:`, `tel:`, connector OAuth, and remote-pairing links always leave the app via **unwrapped** `openExternalUrl`. The in-app router is a separate function; `openExternalUrl` stays the system-only opener (`https` / `mailto` / `tel` only).

8. **Remote-web and mobile keep the system/OS browser.** Show no fake in-app chrome.

9. **macOS 14+ feature gate in Rust.** `browser_attach` returns an error on macOS < 14 (and never calls `data_store_identifier`, which wry would otherwise fall back to the **default** `WKWebsiteDataStore` shared with `main`). React hides the preference using `browser_os_version_supports_browser`. Same pattern as computer-use.

10. **Agent automation is out of v1.** If it ships later, it is a scoped, automation-owned target — never `TAURI_WEBVIEW_AUTOMATION`, never `Webview::eval` on a tab the user is looking at, never a debugging port. Computer-use continues to own "drive real Chrome." Optional `automationOwned: false` on the tab struct is allowed; no daemon types.

11. **Do not mix this with extension webviews.** Different trust, different cookie store, different IPC rules.

12. **Security policy is in the manager PR, before default-open.** Scheme allowlist, app-origin deny, **unconditional daemon-port 4123 deny**, private-network navigation deny with per-webview one-shot allows, first `WKContentRuleList` (including `ipc:`/`tauri:`/`asset:` and 4123 even from private origins), IPC script **and** `ipc` message-handler strip, **wrapped** UIDelegate deny (mic/camera/geo/notifications) without replacing wry's popup/file-picker paths, popup emit, and crash handling all land in PR 3. PR 5 (default-open) depends on that policy **and** on PR 4 consuming popup-to-tab. Phase 1.1 is polish (resize snapshot, idle destroy, download folder, rule-list extras), not the first private-network defense.

## Proposed Design

### Architecture

```mermaid
flowchart LR
  subgraph Trusted["Trusted app webview (label: main)"]
    Chat["Conversation pane"]
    Chrome["Browser chrome<br/>tabs, address bar, profile"]
    Review["Review surface<br/>DiffPanel"]
    Router["Link router"]
  end

  subgraph Native["Child WKWebViews (labels: fd-browser-*)"]
    TabA["Tab A<br/>data_store_identifier: falcondeck"]
    TabB["Tab B<br/>same store"]
    TabI["Incognito tabs<br/>shared nonPersistent data store"]
  end

  Chat -->|http(s) click| Router
  Router -->|default| Chrome
  Router -->|⌘-click / preference / mailto / oauth / pairing| OS["System browser / handler"]
  Chrome -->|invoke browser_* on main only| Mgr["DesktopBrowserManager<br/>lib.rs + browser.rs"]
  Mgr -->|add_child / set_size / hide / navigate| TabA
  Mgr --> TabB
  Mgr --> TabI
  Chrome -.->|measured bounds| Mgr
```

```mermaid
sequenceDiagram
  participant User
  participant React as App webview (main)
  participant Cmd as Tauri commands (app ACL: main only)
  participant Mgr as DesktopBrowserManager
  participant WK as Child WKWebView

  User->>React: Click https://docs.rs in transcript
  React->>React: resolveUrlOpenTarget (in-app)
  React->>React: show rail, surface=browser, reuse or create tab
  React->>Cmd: browser_attach {tabId, url, bounds, profileId, visible}
  Cmd->>Mgr: macOS 14 check, harden, add_child
  Mgr->>WK: strip scripts, remove ipc handler, deny media, content rules
  Mgr->>WK: one-shot allow keyed (label, url), never port 4123; then navigate
  WK-->>Mgr: on_page_load / title changed
  Mgr-->>React: event falcondeck://browser-state
  User->>React: Drag rail
  React->>Cmd: browser_set_bounds {tabId, bounds}
  Cmd->>WK: set_position + set_size
```

Ownership:

| Concern | Owner | Why |
| --- | --- | --- |
| Native webview lifecycle, navigation policy, cookies, downloads, key monitor | `apps/desktop/src-tauri` (`browser.rs`) | Only the shell can host `WKWebView` / `NSEvent` |
| Tab metadata, chrome, bounds measurement, link routing | `apps/desktop/src` React | Layout authority is the renderer, as in BB |
| Device-local preference + tab restore | `localStorage` (`falcondeck.desktop.browser.v1`) | Same pattern as shortcuts and panel visibility; must not sync to phones |
| Daemon / `falcondeck-core` / `client-core` | Unchanged in v1 | No native view on remote hosts; sessions still belong to agents |
| Real Chrome automation | Computer-use workstream | Signed-in OS browser, AX/TCC, different threat model |

### Native view architecture (Tauri 2.11.5)

Pinned stack: `tauri = 2.11.5` (`apps/desktop/src-tauri/Cargo.toml`), `tauri-runtime-wry 2.11.4`, `wry 0.53.5`.

**Enable `unstable`.** `WebviewBuilder` is `pub` only with `feature = "unstable"`; otherwise it is `pub(crate)`. `Window::add_child` is `cfg(all(desktop, feature = "unstable"))`. The JS command `create_webview` is gated on `unstable` and is **not** in `core:webview:default` (that set is get-all / position / size / toggle-devtools only). Still do **not** grant `core:webview:allow-create-webview`. Child webviews are created only from Rust, invoked by the trusted `main` webview.

`browser_attach` is `async`. All `WKWebView` handle work (`with_webview`, back/forward/can*) goes through **one** manager method that `run_on_main_thread`s. Do not call `with_webview` from a sync command (Tauri documents deadlocks on analogous APIs).

Hard errors before `add_child`:

- macOS < 14 → error, no webview. Never call `data_store_identifier` on 12–13.
- Hardening function (scripts, ipc handler, UIDelegate, content rules) must succeed before the first non-`about:blank` navigation. Tests and debug commands use this same function; there is no "naked" attach.

Creation sketch:

```rust
// Conceptual; real code lives in apps/desktop/src-tauri/src/browser.rs
let mut builder = tauri::webview::WebviewBuilder::new(
    format!("fd-browser-{tab_id}"),
    tauri::WebviewUrl::External("about:blank".parse().unwrap()),
)
.focused(false)
.devtools(cfg!(debug_assertions))
.on_navigation({
    let tab_id = tab_id.clone();
    move |url| manager.allow_navigation(&tab_id, url) // keyed (webview_label, url)
})
.on_new_window(|url, _features| {
    manager.note_popup(url); // rate-limit + emit falcondeck://browser-open-tab
    tauri::webview::NewWindowResponse::Deny
})
.on_download(|_webview, event| handle_download(event))
.on_document_title_changed(|webview, title| emit_state(&webview, title))
.on_page_load(|webview, payload| emit_state_from_load(&webview, payload));

match profile.kind {
    ProfileKind::Persistent => {
        builder = builder.data_store_identifier(profile.store_id);
    }
    ProfileKind::Incognito => {
        // NOT builder.incognito(true) — that allocates a fresh nonPersistent
        // store per view (wry 0.53.5 wkwebview/mod.rs). NOT a reused
        // WKWebViewConfiguration — wry using_existing_config would re-inject
        // IPC scripts/handlers onto the shared WKUserContentController.
        // Share the data store only:
        let config = WKWebViewConfiguration::new();
        config.setWebsiteDataStore(&manager.incognito_store());
        builder = builder.with_webview_configuration(config);
    }
}

let webview = main_window.add_child(
    builder,
    tauri::LogicalPosition::new(bounds.x, bounds.y),
    tauri::LogicalSize::new(bounds.width, bounds.height),
)?;

manager.harden_child(&webview)?; // must run before navigate()
manager.allow_next_navigation(&tab_id, &user_url); // one-shot keyed (label, url); never port 4123
webview.navigate(user_url)?;
```

`harden_child` via `Webview::with_webview` (pin Tauri; this handle is minor-unstable):

1. `WKUserContentController::removeAllUserScripts()` — drops Tauri's injected `window.isTauri` / `__TAURI_INTERNALS__` / IPC glue (`prepare_pending_webview`).
2. `removeScriptMessageHandlerForName("ipc")` (wry's `IPC_MESSAGE_HANDLER_NAME`). Scripts gone is not enough: a page that knows the invoke payload can still `webkit.messageHandlers.ipc.postMessage(...)`. The native handler otherwise stays until webview drop. Remove any other wry handlers discovered on the controller in the same pass. This still does **not** unregister Tauri URI-scheme handlers (`ipc:`, `tauri:`, `asset:`); those are blocked in the content-rule list (layer 2).
3. **Wrap, do not replace**, wry's `WryWebViewUIDelegate` **before any untrusted URL**. That class owns `createWebViewWithConfiguration` (`on_new_window` / popup emit) and `runOpenPanelWithParameters` (file picker). `setUIDelegate` with a new object would silently kill both. Keep wry's delegate as the `WKUIDelegate` and intercept only permission selectors (media, geolocation, notifications) via a forwarding wrapper composed on top of it. wry 0.53.5 `request_media_capture_permission` calls `WKPermissionDecision::Grant`. FalconDeck already has `com.apple.security.device.audio-input` for dictation, so an untrusted page would get the **microphone without a new TCC prompt**. Deny camera, microphone, geolocation, and notifications. After `harden_child`, `window.open` must still emit `falcondeck://browser-open-tab` and `<input type=file>` must still open `NSOpenPanel`.
4. Install the first `WKContentRuleList` (async `WKContentRuleListStore.compile` + `addContentRuleList`). This is v1 work, not polish. wry does not wrap it. Rules: block subresources to IP literals / `localhost` / RFC1918 literals; **always** block `DEFAULT_DAEMON_PORT` (4123) even when the document origin is private; block `ipc:`, `tauri:`, `asset:`, and `http://ipc.localhost` / `https://ipc.localhost` (IPC can be `fetch` to that scheme, not only `webkit.messageHandlers.ipc`). If wry allows skipping protocol registration on a custom configuration, do that for browser children; otherwise the rule list is the v1 backstop.
5. Set `allowsBackForwardNavigationGestures`.
6. Back/forward/can* stay on the manager's main-thread WKWebView wrapper. Tauri 2.11.5 has `navigate`, `reload`, and `url`, but no `go_back` / `go_forward`.

Do **not** use `WebviewBuilder::auto_resize()`. Window chrome and the rail move independently of `NSWindow` resizes; the renderer remains placement authority.

#### Crash handling

`lib.rs` today reloads every label on `on_web_content_process_terminate`. For `fd-browser-*`:

- Do **not** `reload()`. Hardening (stripped scripts, removed ipc handler, UIDelegate, rule list) is not guaranteed to re-apply across a process relaunch of that view.
- Emit `falcondeck://browser-state` with `loading: false` and a crashed flag / `errorText`. React shows the empty/error state; the user hits Reload (which `detach` + `attach`s a new hardened view).
- A hostile tab crash must not look like the main shell crashing.

#### Bounds, z-order, resize

Child `WKWebView`s composite as sibling `NSView`s of the app webview. They paint **above** React.

- Placeholder `div` below browser chrome. `ResizeObserver` + rAF coalescing → integer CSS-pixel rects → `browser_set_bounds`. Rust converts with the window scale factor and clamps to the window inner size (port BB's `clampBbDesktopBrowserViewBounds`).
- Native view is shown only when: rail visible, surface = Browser, this tab selected, coordinator says uncovered, window not in a live-resize burst.

**Visibility coordinator ships in PR 4** (z-order is High, not a 1.1 item). Hide every native view when any of:

| Trigger | Notes |
| --- | --- |
| Command palette open | `createPortal` `role="dialog"` `z-50` — **under** the WKWebView unless hidden |
| Any `aria-modal="true"` | Settings is a takeover (rail already unmounts) but keep the check |
| `activeMainViewId` set | Settings / Activity / Plugins / Extensions / … drop the rail in `App.tsx` |
| Extension tool detail in the rail | Already replaces `DiffPanel` |
| Rail close / `railOpen → false` | Hide immediately; `DesktopShell` unmounts contents after 220 ms |
| Window live-resize | Hide at start; re-show after ~80–120 ms + fresh bounds. JPEG snapshot is Phase 1.1 |
| Rail-width animation or surface snap | `PANEL_TRANSITION_MS = 220`; also hide during the Browser/Review width snap |
| Manual `coverNativeBrowser` | Chat `MenuSurface` / composer menus are **not** `role="dialog"`; callers that open a menu overlapping the rail must cover |

Native `tauri-plugin-dialog` sheets (quit prompt, save panel) are separate `NSWindow`s — **do not** hide for those.

The bottom terminal panel can overlap the rail corner. v1: hide native views while the terminal is open **or** inset the placeholder above the terminal; pick inset if it is cheap, otherwise hide.

`⌥⌘B` (`toggleChanges`) hides/shows the whole rail even when surface = Browser. That matches today's command. Switching Review ↔ Browser is the segmented control, not this shortcut.

#### Rail width (shell API, PR 4 — not optional)

`DesktopShell` / `ResizableSidePanel` cannot restore a second width by changing `defaultSize` after mount (it is frozen; remounting `id="rail"` re-normalises the group and can spring the sidebar).

PR 4 extends the shell:

```ts
// DesktopShell / ResizableSidePanel additions
railMinSize: string           // "280px" Review, "360px" Browser
railContentWidth: string      // matches min; used while animating shut
onRailSizeChange?: (size: string) => void
// Imperative resize when surface flips, without remounting id="rail"
```

Persist two sizes in `falcondeck.desktop.browser.v1`: `reviewRailWidth` (default `"25%"`, min 280px) and `browserRailWidth` (default `"40%"`, min 360px). On surface flip: hide native views → imperative `resize` → fresh bounds → show. Nested `SegmentedControl`s in 280px are cramped; the wider browser rail is load-bearing for the chrome mockup.

#### Inactive-tab retention

- Tab **metadata** (id, url, title, profileId, createdAt) is persisted and cheap.
- Native views for inactive tabs stay **alive and hidden** so form state / SPA routing survives tab switches.
- Cap live native views at **6**. LRU-destroy the native view of the least-recently-shown tab; keep metadata. Reselect re-attaches and reloads `url`.
- Incognito: destroying the last incognito native view drops the **shared** `WKWebsiteDataStore` (the manager releases that store, not a shared configuration). Closing the last incognito tab is a hard discard; confirm if any incognito tab still has a typed URL.

Expected cost: ~50–150 MB RSS per live `WKWebView`. Six live tabs ≈ 0.3–0.9 GB. Destroying hidden views after idle is optional Phase 1.1.

#### What not to use

| Approach | Why not |
| --- | --- |
| `<iframe>` / `frame-src` | CSP is `'none'` for a reason; iframes share the app origin/process too closely. Child webviews do not inherit that CSP. |
| `WebviewWindowBuilder` per tab | Extra windows, extra traffic lights, breaks the rail |
| Electron `WebContentsView` | Wrong runtime |
| wry `WebContext` `data_directory` | Linux/Windows partition; WebKit ignores it |
| `WebviewBuilder::incognito(true)` for a shared session | New `nonPersistent` store per view |
| One shared `WKWebViewConfiguration` for incognito | wry `using_existing_config` re-injects IPC scripts/handlers on the shared `WKUserContentController` |
| `TAURI_WEBVIEW_AUTOMATION=true` | wry then sets `set_allows_automation` on the first context. Never. |
| JS `create_webview` | Not in `core:webview:default`; still do not grant it. Rust-only. |

### Profile / cookie model

A **profile** is a cookie + HTML storage identity, not a tab.

```text
Profile
  id:            "falcondeck" | "incognito" | later "project:{workspaceId}" | later user-named
  kind:          persistent | ephemeral
  store_id:      [u8; 16]   // only for persistent; WKWebsiteDataStore identifier
  display_name:  "FalconDeck" | "Incognito" | project name
  created_at
```

v1 ships two:

| Profile | Store | Lifetime | Shared with |
| --- | --- | --- | --- |
| `falcondeck` | `data_store_identifier` = fixed UUID (e.g. DNS-namespace UUID of `falcondeck.browser.default`) | Survives app relaunch; WebKit writes under the app's WebKit data directory | Every non-incognito tab, every task, every project |
| `incognito` | **One** manager-owned `WKWebsiteDataStore::nonPersistentDataStore()`. Each tab gets a **new** `WKWebViewConfiguration` with `setWebsiteDataStore(shared_store)`, then `with_webview_configuration(that_copy)` | Discarded when the last incognito webview is destroyed and the manager drops the store | Other incognito tabs, only while any remain |

Integration tests (PR 7): (1) two incognito tabs; `set_cookie` (or a login) on A is visible to B; after both close, a new incognito tab does not see it. (2) attaching the second incognito tab does **not** restore `window.ipc` / `__TAURI_INTERNALS__` on the first.

Sharing scope:

- **v1 default = one persistent browser identity for the whole Mac app**, plus one shared incognito session. GitHub/docs/Vercel *that accept embedded WebKit* stay signed in while the user hops tasks.
- Tabs using the same profile share cookies, localStorage, and IndexedDB because they share a `WKWebsiteDataStore`.
- **Per-project** (v2): `store_id` derived from `workspace_id`.
- **Per-thread** (later, maybe never): usually the wrong grain.
- Agents (later) **do not pick a user profile**. Automation gets an automation-owned ephemeral store.

Clear-data: Settings → Browser → "Clear FalconDeck browsing data" calls `Webview::clear_all_browsing_data` on a live view of that store (wry clears that webview's `configuration.websiteDataStore`) and `AppHandle::remove_data_store` / `fetch_data_store_identifiers` as needed. Incognito has nothing durable to clear.

### Chrome cookie import (honest feasibility)

On modern macOS Chrome, **silent import of the live cookie jar is largely infeasible**.

| Artifact | Location | Encryption | Importable? |
| --- | --- | --- | --- |
| Cookies | `~/Library/Application Support/Google/Chrome/<Profile>/Cookies` | Chrome 80–126: AES-128-CBC or AES-256-GCM keyed by Keychain "Chrome Safe Storage". Chrome **127+**: [app-bound encryption](https://security.googleblog.com/2024/07/improving-security-of-chrome-cookies-on.html). | Other apps cannot decrypt 127+ cookies even with Keychain access. Older Chrome: possible with Keychain prompt + file read. |
| Passwords | `Login Data` | Separate, also app-bound | **Never.** |
| localStorage / IndexedDB | LevelDB under `Storage/` | Not the cookie key | **Not in this project.** |
| Open tabs | `Current Tabs` / `Last Tabs` | Unencrypted but undocumented | **Not in v1.** |
| Safari cookies | Safari container + Keychain | SIP / TCC | Not via cookie scrape. `SFSafariViewController` shares Safari's jar but is the wrong product (see Alternatives). |
| Firefox | `cookies.sqlite` | NSS, optional master password | Later. |

Product path:

1. **v1:** Sign in *inside* FalconDeck where the site allows embedded WebKit. GitHub-style top-level OAuth may work. **Google (and similar IdPs) are expected to fail** with `disallowed_useragent`. UI copy: "Open in System Browser" / computer-use, not "just sign in here." Popup-to-same-profile-tab is required before default-open, because many logins use `window.open`.
2. **v2:** "Import cookies from file…" (Netscape / JSON). User-initiated `NSOpenPanel`. Parse in Rust. `Webview::set_cookie`. Do not copy the import file into app support.
3. **v2 experiment:** "Import from Chrome" with expected failure on 127+. Never touch `Login Data`.
4. Computer-use remains the answer to "the agent should use the Chrome profile I am already signed into."

### Default link routing

A pure helper (unit-tested) decides the destination. Wire it through `installExternalLinkHandler` and `WebLinkProvider`. **Do not** route `openExternalUrl` through the in-app branch — PluginsView and RemotePairingPopover call it directly and must keep today's system-only behavior (`forceSystem` is implicit because they never call the router).

```ts
export type UrlOpenTarget =
  | 'in-app-browser'
  | 'system-browser'
  | 'system-handler' // mailto, tel
  | 'unhandled'

export function resolveUrlOpenTarget(args: {
  url: string
  desktopBrowserAvailable: boolean // Tauri + Rust macOS 14 check succeeded
  openLinksInAppBrowser: boolean
  modifiers: { metaKey: boolean; altKey: boolean; button: number }
  forceSystem: boolean
  source: 'chat' | 'address-bar' | 'oauth' | 'pairing' | 'palette'
}): UrlOpenTarget
```

`installExternalLinkHandler` must read `metaKey` / `altKey` / `button` and pass them in. Today's `shouldHandleClick` does not.

Rules:

| Input | Target |
| --- | --- |
| `mailto:`, `tel:` | `system-handler` via existing `open_external_url` |
| `javascript:`, `data:`, `file:`, `tauri:`, unknown schemes | `unhandled` |
| Connector OAuth and remote pairing (`source: 'oauth' \| 'pairing'`, or any direct `openExternalUrl` call) | **Always** system-browser. Never wrap `openExternalUrl`. |
| Ordinary `http:` / `https:` from chat, address bar, palette | `in-app-browser` if available and preference on; else `system-browser` for `https:`, **`unhandled` for `http:`** (system opener still rejects `http:`). URLs whose host is loopback/`localhost` **and** port is `DEFAULT_DAEMON_PORT` (4123) are **`unhandled` even in-app** — agent markdown must not attach `/api/snapshot`. |
| ⌘-click / context menu "Open in System Browser" | `system-browser` (`https:` only; `http:` stays unhandled at the system opener) |
| ⌥-click | in-app **incognito** tab (once PR 7 exists; until then, in-app current profile) |
| Middle-click | in-app new background tab in the current profile |

Preference: `falcondeck.desktop.browser.v1.openLinksInAppBrowser`, default `true`, device-local. **Do not** add this to `FalconDeckPreferences`. **Do not show the Settings toggle** until `browser_os_version_supports_browser` is true **and** the manager exists (otherwise it is a no-op switch, and the `http:` fallback cannot open `http://` links).

Context menu on `WebLinkAnchor`: third row "Open in System Browser". `WebLinkMenu` currently hardcodes `itemCount={2}` — desktop passes the extra row; remote-web has no provider and keeps `target=_blank` with two items. Do not add a redundant item on remote-web.

Always-external: prefer tagging the caller (`source`) over URL guessing.

### Navigation, popups, downloads, permissions

Implemented in Rust so a hostile page cannot bypass the renderer. **This whole subsection is PR 3**, except the React popup consumer (PR 4) and the save-panel UX (PR 8). PR 5 must not ship until PR 3 policy + PR 4 popup consumer exist.

Tauri's `on_navigation` is `Fn(&Url) -> bool`. wry 0.53.5 (`decidePolicyForNavigationAction`) invokes it for **every** navigation action, including **iframes and form posts**. It does **not** run for subresource `fetch` / `img` / `WebSocket`. There is **no** `WKNavigationType`, main-frame bit, or user-vs-page flag. Do not invent `NavigationSource` on that callback.

**Three layers:**

1. **`on_navigation`** (all navigations, including iframes and form posts). Each child closes over its `tab_id` / webview label — there is **no** process-global URL set:
   - Scheme allowlist: `http:` / `https:` only (plus `about:blank` as the pre-nav placeholder). Block `file:`, `javascript:`, `data:`, `blob:` top-level, custom schemes, `tauri:`, `ipc:`, `asset:`.
   - **Always deny the app's own origins**, including for address-bar input: `tauri://localhost`, `http://tauri.localhost`, `https://tauri.localhost`, `http://localhost:1420`, `http://127.0.0.1:1420`. A child on those origins is `Origin::Local` and, before/without a complete app ACL, would see custom commands.
   - **Always deny the daemon**, including one-shot and address-bar: host `127.0.0.1` / `localhost` / `::1` **and** port `DEFAULT_DAEMON_PORT` (4123). Chat links are often **agent-authored**; a transcript link to `http://127.0.0.1:4123/api/snapshot` must not attach and render secrets. The TS router also returns `unhandled` for that class so React never calls `browser_attach` with it.
   - Deny other loopback (`127.0.0.0/8`, `::1`, `localhost`) and RFC1918 / link-local **unless** the URL is in that webview's **one-shot allow**, keyed `(webview_label, url)`. `browser_navigate` / `browser_attach` insert the user-typed or chat-clicked URL for a single matching `on_navigation` on **that** child, then remove it. A pending allow for `http://localhost:3000` on tab A must not be consumed by tab B. Address-bar navigations still pass through `on_navigation`; "user typed it" is **not** a Tauri enum.
2. **`WKContentRuleList`** for subresources: IP literals, `localhost`, RFC1918 literals; **unconditional** block of port 4123 (a page whose origin is `http://localhost:3000` must not `fetch` the daemon — do **not** exempt "origin is also private" for 4123); `ipc:`, `tauri:`, `asset:`, `http://ipc.localhost`, `https://ipc.localhost`. Cannot see the connected IP behind a public hostname.
3. **Daemon CORS + `require_loopback_host` + `has_allowed_websocket_origin`** unchanged. Never add an in-app-browser origin to `ALLOWED_BROWSER_ORIGINS`. CORS already stops JS from *reading* cross-origin JSON; Axum `Json<…>` extractors reject simple form POSTs, so mutation CSRF is weaker than a naive CSRF story. Layer 1's **unconditional 4123 deny** is what stops `/api/snapshot` from rendering in the child view. Residual: `no-cors` GETs to other loopback ports still need layer 2; future simple endpoints on 4123 stay blocked by layers 1–2.

**Hostname DNS rebinding to RFC1918** (not an IP literal) is **not** covered by a literal/`localhost` rule list. The daemon's `Host` check covers the daemon only. Residual risk: a public hostname that resolves to LAN can still be fetched as a subresource. Accept in v1; do not pretend the rule list sees the connected IP. Document in Risks.

**Popups / `target=_blank`:** native OS windows are always `NewWindowResponse::Deny`. Allowed `http(s)` URLs (same scheme + private-network policy) emit `falcondeck://browser-open-tab` `{ tabId, url }` to `main`. Sliding window: max 3 popup tabs / 10 s / source tab. React (PR 4) must consume this by opening a tab in the **same profile** before default-open (PR 5) — OAuth-inside-a-site needs the popup. For the one-tab chrome PR, that means a **minimal extra tab** (not waiting for the full strip in PR 6).

**Downloads (PR 8, after default-open is allowed):** `on_download` on `DownloadEvent::Requested` — do not let WebKit pick a default path. Save panel via `tauri-plugin-dialog` (`dialog:allow-save` on the **main** capability). v1 default: always ask. Until PR 8, PR 3 may **deny** downloads (user uses Open in System Browser).

**Device permissions:** deny via the **wrapping** UIDelegate as a hard precondition of `add_child` (see `harden_child`). Clipboard: write-only if distinguishable; else deny programmatic clipboard.

**User agent:** default WKWebView (Safari-like). Do not spoof Chrome. This is why Google OAuth fails; we will not lie to IdPs.

**Devtools:** `devtools(cfg!(debug_assertions))`. `core:webview:allow-internal-toggle-devtools` must not apply to children (app ACL + webview labels). Never add an eval command.

**IPC size caps:** URL 4096, title 1024.

### Tabs and chrome

Browser chrome is FalconDeck UI, tokenized (`DESIGN.md`). Not a fake Safari toolbar.

```
┌─ rail ─────────────────────────────────────────────┐
│  [Review | Browser]     ⋮ profile · open in Chrome │  ← SegmentedControl kind="tabs"
├────────────────────────────────────────────────────┤
│  [tab] [tab] [+]                              [×]  │  ← tab strip (minimal in PR 4, full in PR 6)
├────────────────────────────────────────────────────┤
│  ← → ↻  [ https://docs.rs/tauri          ]  ⧉     │
├────────────────────────────────────────────────────┤
│           native WKWebView placeholder             │
└────────────────────────────────────────────────────┘
```

- Surface switcher at the top of the rail. Review keeps `info | changes | files`. Browser does not add a fourth FileListView tab.
- Chat link: `showRail()`, `surface = 'browser'`, reuse or create tab.
- File from transcript: `showRail()` + Review (`handleOpenFileDiff`). File click always forces Review; web link always forces Browser.
- New-tab page: React empty state, focused address field, last 8 closed URLs (local only). Non-URL input → DuckDuckGo `https://duckduckgo.com/?q=`. No search-engine setting in v1.
- Profile chip: `FalconDeck` | `Incognito` (incognito from PR 7).

#### Keyboard and focus

Focus states:

| State | First responder | Shortcut behavior |
| --- | --- | --- |
| `app` | Conversation, sidebar, Review, composer | Existing `App.tsx` `document` listener. Browser chords `Mod+T` / `Mod+W` / `Mod+L` / `Mod+R` do **not** fire. `toggleBrowser` (`Mod+Shift+B`) does. |
| `chrome` | Address bar, tab strip, surface switcher (React) | Browser chords + global app chords (`Mod+K`, `Mod+,`, …) |
| `page` | Child `WKWebView` | React listener is **dead**. A native `NSEvent` local monitor (PR 4) matches the **live** binding table from `falcondeck.desktop.shortcuts.v1`, not hardcoded defaults. |

`Mod+T` / `Mod+W` / `Mod+L` / `Mod+R` are scoped to `chrome | page`. `Mod+W` closes a browser tab only in those states.

**Live shortcut table (PR 4, required).** JS already resolves chords via `commandForEvent` / `bindingsFor` in `shortcuts.ts`. Users rebind everything in Settings → Keyboard. Rust must not parse a stale default list.

- `main` pushes the resolved map whenever shortcuts change: `browser_set_shortcut_bindings` (also sent on attach). Payload is `{ commandId: string[] }` using the same chord strings as `shortcuts.ts` (`Mod+K`, `Mod+Shift+B`, …).
- The monitor matches that table. On hit it either emits `falcondeck://browser-shortcut` `{ commandId }` to `main` (preferred: one dispatcher in `App.tsx`) or invokes the same command ids.
- Editable-field detection: WKWebView-side if cheap (`isEditableTarget` analogue). If not, treat **all non-meta / non-control chords as typing** while a child is first responder, and only steal chords that include Command or Control. `Mod+K` still works. Do not steal single-character bindings from the page.

Command palette items ("New browser tab", "Toggle browser", "Open in system browser") need a chat-ui `extraActions` (or equivalent) hook — the palette's action list is closed today. Land that API in PR 4; desktop-only.

### How this coexists with the conversation pane

Center column remains `DesktopConversationPane`. Main views still drop the rail. Native views hide for that takeover and do not migrate into the main column in v1.

### Remote-web and mobile

| Client | v1 behavior |
| --- | --- |
| Desktop macOS 14+ | In-app browser |
| Desktop macOS 12–13 | System browser; Settings copy that in-app browser needs macOS 14 |
| `apps/remote-web` | Keep `window.open`. No extra context-menu item |
| `apps/mobile` | Keep `Linking.openURL` |

### Daemon vs desktop ownership

v1 daemon knowledge: **none.**

Desktop-only Tauri commands (async, invoked exclusively from `main`):

```text
browser_attach { tabId, url, bounds, visible, profileId }
browser_detach { tabId }
browser_navigate { tabId, url }          // one-shot allow keyed (label, url); never port 4123
browser_go_back / browser_go_forward / browser_reload / browser_stop { tabId }
browser_set_bounds { tabId, bounds }
browser_set_visible { tabId, visible }
browser_set_profile { tabId, profileId } // recreates the native view
browser_set_shortcut_bindings { bindings } // live map from falcondeck.desktop.shortcuts.v1
browser_list_profiles
browser_clear_profile { profileId }
browser_os_version_supports_browser -> bool
```

No `browser_import_cookies` in v1.

Events (host → `main` only), same prefix as dictation/activity:

```ts
// falcondeck://browser-state
type BrowserStateEvent = {
  tabId: string
  url: string            // max 4096
  title: string          // max 1024
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  profileId: 'falcondeck' | 'incognito'
  errorText?: string | null  // crashed / load error
}

// falcondeck://browser-open-tab
type BrowserOpenTabEvent = {
  tabId: string          // source tab
  url: string            // max 4096
}

// falcondeck://browser-shortcut  (PR 4; page-focus NSEvent hits)
type BrowserShortcutEvent = { commandId: string }

// falcondeck://browser-download-finished  (PR 8)
```

`canGoBack` / `canGoForward` / title / URL are gathered on the main thread inside the manager after load/title/back/forward, then emitted. React does not poll.

### Agent control (later, not v1)

```text
Computer-use / cua-driver     →  user's real Chrome/Safari (signed-in OS profile)
In-app browser v1             →  human browsing in FalconDeck
In-app automation (later)     →  agent drives an automation-owned FalconDeck tab
```

The in-app WKWebView is **not** a cua-driver target. PR 13 / a one-line follow-up in `docs/COMPUTER-USE.md` should say so. Do not add `DaemonCapabilities.browser_automation` now.

If/when agents may navigate FalconDeck tabs: CLI-shaped, JSON out; daemon authorizes; desktop creates `automationOwned: true` with an ephemeral store; never `eval` on user tabs; never a CDP port. v1 ships at most the boolean on the tab struct.

### Security boundaries

Defense in depth. Assume the page is hostile.

1. **Process / view isolation.** Untrusted documents never load in `main`. Labels `fd-browser-*`.
2. **App ACL manifest** in two capabilities: existing commands on `webviews: ["main", "activity", "dictation"]`; `browser_*` on `main` only. No `remote` URLs. No `windows: ["main"]` once children exist. Activity keeps `focus_main_window` + `open_external_url`; dictation keeps every `dictation_*` the overlay uses.
3. **Capability `webviews` not `windows`** so plugin commands (`core:default`) do not inherit to children. This is necessary and **not sufficient** for custom commands.
4. **Remote origin.** `https://…` children are `Origin::Remote` and cannot use local-only capabilities. Backstop, not the only control.
5. **Block app origins** even on user-typed URLs, so a child cannot become `Origin::Local`.
6. **Strip user scripts and the `ipc` message handler** before first untrusted navigation. Also block `ipc:` / `tauri:` / `asset:` / `http://ipc.localhost` in the content-rule list — `prepare_pending_webview` still registers those schemes, and IPC can be `fetch`, not only `webkit.messageHandlers.ipc`. Do not add initialization scripts to browser builders. Do not rely on "stripped scripts ⇒ no IPC."
7. **Three-layer navigation / subresource policy** (above). Daemon port 4123 is never one-shot-allowed.
8. **Wrap wry's UIDelegate** (mic/camera/geo/notifications Deny) as a precondition of `add_child`, because dictation already entitled the mic. Do not `setUIDelegate` a replacement — that drops popups and the file picker.
9. **Cookie import is user-initiated** (phase 3), parsed in Rust, cookies only.
10. **Do not** grant `core:webview:allow-create-webview`. Prefer custom `browser_*` commands.
11. **Daemon CORS / loopback host / WS origin stay as they are.**

Threat model (abridged):

| Threat | Severity | Mitigation |
| --- | --- | --- |
| Child on `http://localhost:1420` / `tauri://localhost` invokes `open_external_url`, host secrets, `read_local_text_file` | Critical | App ACL on trusted labels only; **always deny app origins** in `on_navigation`; ipc handler removed |
| Remote `https://` page invokes custom commands | Critical | No `remote` capability; `has_app_acl_manifest` once PR 1 lands; ipc handler removed |
| Public page or agent markdown navigates / iframes `http://127.0.0.1:4123/api/snapshot` (secrets render) | Critical | **Always deny port 4123** (no one-shot, not even address-bar); TS router `unhandled`; content rules block 4123 even from private origins |
| `fetch`/`img` to loopback literals or `ipc:`/`tauri:` | High | `WKContentRuleList` (including `ipc:`, `tauri:`, `asset:`, `ipc.localhost`); daemon CORS (no read of JSON) |
| Hostname rebinding to LAN (not the daemon) | Medium | Residual; daemon `Host` check only covers the daemon |
| Microphone without TCC prompt | High | **Wrap** wry UIDelegate → Deny **before** first navigation; dictation already set `audio-input`; popups/file-picker still fire |
| Popup / tab flood | Medium | Rate limit; deny native windows |
| Cookie import exfiltrates Chrome passwords | High | Never import `Login Data` |
| Native view covers command palette / menus | High | Visibility coordinator in PR 4 |
| Tab crash reloads an unhardened view | High | Do not use the global recover-by-reload path |
| `Webview::eval` as "address bar JS" | High | Do not add an eval command |
| Incomplete app ACL when `permissions/` is added | Critical | Same PR lists every current `invoke_handler` command; CI fails if a command is unregistered |
| Later `"windows": ["main"]` capability | Critical | Test walks `capabilities/**/*` |

### UI / settings

- Settings → **General**: switch "Open links in FalconDeck browser". Discoverable, like BB. **Hidden** until macOS 14 **and** the manager is present. Default on when shown.
- Settings → **Browser** (new `SettingsSectionId`, lucide `Globe`, "Tabs, profiles, and cookies"): profile list, clear data, default profile, later import. **Does not move** the General switch; links to it. Same availability gate.
- Command palette via `extraActions`: "New browser tab", "Toggle browser", "Open in system browser".

Empty / unavailable: tokenized `EmptyState`. macOS 12–13: "The in-app browser needs macOS 14 or later."

## API / Interface Changes

### v1 (desktop only)

No changes to `crates/falcondeck-core`, `packages/client-core`, relay, mobile, or remote-web protocol. No `DaemonCapabilities.browser_automation`.

Tauri:

- `Cargo.toml`: add `unstable` to existing `macos-private-api` features.
- New `apps/desktop/src-tauri/permissions/` app ACL for every current custom command + `browser_*`.
- Two capability files: `default.json` with existing commands on `"webviews": ["main", "activity", "dictation"]` (omit `windows`); `browser.json` with `browser_*` on `"webviews": ["main"]` only. Later `dialog:allow-save` on the **browser** (or default-main) capability, never on children.
- `browser.rs` + `invoke_handler` + special-case `on_web_content_process_terminate`.
- Frontend wrappers next to `openExternalUrl` without wrapping it.
- `packages/chat-ui`: `WebLinkMenu` extra row (desktop-only); command palette `extraActions`.

### Later (agent control)

Only then: `DaemonCapabilities.browser_automation` and core types. Start in `falcondeck-core` / `client-core`. One sentence in `docs/COMPUTER-USE.md`: in-app WKWebView is not a cua-driver target.

## Data Model Changes

No daemon schema, no conversation DB, no cookie backup through `backup.rs`.

```ts
type BrowserPersistedStateV1 = {
  version: 1
  openLinksInAppBrowser: boolean
  surface: 'review' | 'browser'
  reviewRailWidth: string   // default "25%"
  browserRailWidth: string  // default "40%"
  lastProfileId: 'falcondeck' | 'incognito'
  activeTabId: string | null
  tabs: Array<{
    id: string
    url: string        // max 4096
    title: string      // max 1024
    profileId: 'falcondeck' | 'incognito'
    createdAt: number
  }>
}
```

Incognito tabs are not written to disk.

## Observability

- Rust `eprintln!` / `log` on attach/detach/navigation-deny/download/crash, matching existing webview logs. Include whether hardening ran.
- Renderer: no PII; truncated URL on errors.
- Metrics later: attach count, deny-by-scheme, deny-by-private-network, deny-by-app-origin, live-view cap evictions. Not v1-blocking.

## Rollout Plan

1. Land **app ACL + two webview-scoped capabilities** before any child webview. The existing-command capability must cover `main`, `activity`, and `dictation` together (today's set). This PR can break those windows if the allow-list is incomplete — treat it as a desktop-shell regression risk and test activity/dictation (`focus_main_window`, `open_external_url`, `dictation_*`).
2. Land the manager **with** navigation/content-rule policy before React can `browser_attach` a real URL.
3. Ship chrome + default-open in the same release train as that manager. Preference default **on** only when the toggle is shown (macOS 14 + manager).
4. macOS 12–13: `browser_attach` errors; links keep today's path.
5. Rollback: preference off, or a build that ignores attach.

## Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Local-origin child + no/incomplete app ACL | Critical | PR 1 complete allow-list; PR 3 deny app origins; ipc handler removed; tests on `https://example.com` **and** `http://localhost:1420` |
| `windows: ["main"]` plugin-command inheritance | Critical | `webviews` only; glob test on `capabilities/**/*` |
| Public / agent-markdown → `127.0.0.1:4123` snapshot | Critical | Unconditional 4123 deny (nav + content rules + TS router); one-shot never includes it |
| Public → other loopback / iframe | High | `on_navigation` + per-webview one-shot + content rules **before** PR 5 |
| Hostname rebinding to LAN services other than the daemon | Medium | Residual; daemon `Host` check is daemon-only |
| wry Grant + existing mic entitlement | High | Wrap wry UIDelegate → Deny in `harden_child`; no attach without it; do not replace the delegate |
| Google / embedded-WebView OAuth (`disallowed_useragent`) | High (product) | Do not spoof UA; popup-to-tab before default-open; copy points at System Browser / computer-use |
| `on_navigation` cannot see user-vs-page | High | One-shot allow in the manager, not a Tauri enum |
| Z-order vs palette / `MenuSurface` | High | Coordinator in PR 4 |
| Shortcuts swallowed while page focused | High | `NSEvent` monitor in PR 4 matching the **live** `falcondeck.desktop.shortcuts.v1` map pushed from JS |
| Tab crash reloads unhardened view | High | Ignore global reload for `fd-browser-*` |
| `data_store_identifier` on macOS 12–13 shares `main`'s store | High | Hard error in Rust attach |
| Incomplete allow-list when adding `permissions/` | Critical | Generate from `invoke_handler`; one capability for existing commands on main/activity/dictation; second for `browser_*` on main only |
| Reused incognito `WKWebViewConfiguration` re-injects IPC | High | Share `WKWebsiteDataStore` only; fresh configuration per tab; test second attach does not restore `window.ipc` on the first |
| Tauri `with_webview` is minor-unstable | Medium | Pin 2.11.5; one module |
| Live views memory | Medium | Cap 6 |
| `Mod+T` / `Mod+W` steal agent-app shortcuts | Medium | Scope to `chrome \| page` |
| JS `create_webview` exists under `unstable` | Low | Not in `core:webview:default`; do not grant it |

## Alternatives Considered

### 1. Iframe in the React rail

Rejected. CSP `frame-src 'none'` is load-bearing for `main`. Untrusted HTML in the app origin would share the Tauri IPC context even more tightly. Child webviews are not covered by that CSP anyway.

### 2. Separate `WebviewWindow` per tab (or one browser window)

Rejected for v1. Extra windows fight "stay next to the transcript." A dedicated window is a reasonable v2 option reusing `DesktopBrowserManager`.

### 3. Electron / CEF / shipped Chromium

Rejected. Desktop decision is Tauri 2. Chromium would blow up binary size and duplicate computer-use's real-Chrome path.

### 4. Put the browser in the main column (`MainView`)

Rejected for v1. `DESIGN.md` reserves main views for Activity, Settings, extension panels.

### 5. Daemon-owned headless browser (Playwright / WebKit process)

Rejected for the *user* browser. Overlaps computer-use; cannot share WKWebView cookie stores with a visible tab.

### 6. Always use the system browser; skip this feature

Rejected as the product direction. System browser remains the escape hatch and the computer-use target.

### 7. `SFSafariViewController` / `ASWebAuthenticationSession`

Rejected as the browsing surface. They share **Safari's** cookie jar, which looks like "already logged in," but: not Chrome, not multi-tab, not a rail child, not a FalconDeck-owned profile, and they cannot host the Review | Browser chrome. `ASWebAuthenticationSession` is the right tool for **FalconDeck's own** OAuth (connectors already go to the system browser). Keep connector OAuth on `openExternalUrl`. Do not use SFSafariViewController for general browsing.

### 8. Child `WKWebView` via objc2 without Tauri `unstable`

Possible (dictation already uses native handles). Rejected for v1: we would reimplement `on_navigation`, download, new-window, bounds, labels, and crash hooks that `add_child` already wires, and we would still need the app ACL because a leaked IPC is independent of how the view was created. `unstable` + `add_child` is the choice; the ACL/ipc-strip/UIDelegate work remains either way.

## Open Questions

1. **Swipe-back vs in-app back button only.** Default: enable `allowsBackForwardNavigationGestures`; disable if QA finds fights with rail-width dragging.
2. **Default search engine.** v1: DuckDuckGo, no setting.
3. **Download default:** always ask in v1 (PR 8). Confirm a default folder is not needed yet.
4. **Should `http://` system-open stay forbidden?** Yes. In-app allows `http:` under the private-network policy. Do not relax `open_external_url` / TS `isSafeExternalUrl`.
5. **Per-project profiles in v1.5 vs v2.** Product complexity is the reason to wait.
6. **Whether a future "Give this tab to the agent" control is ever acceptable.** Default no.
7. **Terminal vs rail overlap:** hide native views while the terminal is open, or inset the placeholder. Implementer picks inset if cheap.

## Phasing

### Phase 0 — Prerequisite

App ACL manifest + `webviews`-scoped capabilities. No child webview.

### Phase 1 — v1 shippable browser (PRs 2–7 and 9)

Manager **with** navigation/content-rule policy, ipc strip, media deny, popup emit; chrome + shell width + visibility coordinator + key monitor; default-open; multi-tab; shared incognito; General toggle + Browser settings. **This is the first public feature.** Downloads may deny until PR 8 in the same release train.

### Phase 1.1 — Polish

Download save panel (PR 8 if not in the v1 train), resize snapshot, idle-destroy of hidden views, content-rule extras, terminal inset.

### Phase 2 — Per-project profiles

### Phase 3 — Cookie file import, then best-effort Chrome import

### Phase 4 — Agent control (separate design, after computer-use)

Must not conflict with `docs/COMPUTER-USE.md`. Docs-only until then.

## References

- `docs/BB-SIDE-CHATS-AND-BROWSER.md` — BB shipped user browser vs unstarted agent plan
- `/Users/James/www/sites/bb/apps/desktop/src/desktop-browser-view.ts` — view manager, resize snapshots
- `/Users/James/www/sites/bb/apps/desktop/src/desktop-browser-policy.ts` — scheme + popup rate limit
- `/Users/James/www/sites/bb/packages/desktop-contract/src/browser.ts` — attach/bounds/state IPC
- `/Users/James/www/sites/bb/apps/app/src/lib/in-app-browser-link-preference.ts` — default-on in-app routing
- `/Users/James/www/sites/bb/plans/bb-browser.md` — future scoped automation
- `docs/COMPUTER-USE.md` — cua-driver; real Chrome; in-app WKWebView is not a target
- `docs/EXTENSIONS.md` / `docs/PLATFORM.md` — sandboxed webviews later
- `docs/17-desktop-code-review.md` — right rail is a review workspace
- `DESIGN.md` — collapsible panels, tokens
- `apps/desktop/src-tauri/Cargo.toml` — Tauri 2.11.5, `macos-private-api` already on
- `tauri-2.11.5` `webview/mod.rs` — `WebviewBuilder`, `data_store_identifier`, `with_webview_configuration` (per-view config; share the **store**), `add_child`, ACL skip when `!has_app_acl_manifest && is_local`
- `tauri-utils-2.9.3` `acl/capability.rs` — window vs webview matching
- `wry-0.53.5` `wkwebview/mod.rs` — `incognito` → new `nonPersistentDataStore()` per view; `using_existing_config` when `webview_configuration.is_some()`
- `wry-0.53.5` `wkwebview/class/wry_web_view_ui_delegate.rs` — media capture **Grant**
- `wry-0.53.5` `wkwebview/navigation.rs` — `decidePolicyForNavigationAction` (iframes yes, `fetch` no)
- `crates/falcondeck-core/src/lib.rs` — `DEFAULT_DAEMON_PORT` (4123); always deny this port in the in-app browser
- `crates/falcondeck-daemon/src/api.rs` — `ALLOWED_BROWSER_ORIGINS`, `require_loopback_host`, `has_allowed_websocket_origin`
- Chrome app-bound cookie encryption (Chrome 127+)

---

## PR Plan

Each PR is independently reviewable and mergeable. **v1 is PRs 1–7 and 9**, with PR 8 (downloads) in the same release if possible. Do not ship PR 5 until PR 3 policy and PR 4 popup consumer exist. Do not show the Settings toggle until the manager exists.

### PR 1 — App ACL manifest + webview-scoped capabilities

- **Title:** Isolate desktop IPC: app permissions and webview-scoped capabilities
- **Files:** `apps/desktop/src-tauri/permissions/` (allow for **every** current `invoke_handler` command, plus stub `browser_*` allows); `apps/desktop/src-tauri/capabilities/default.json`; `apps/desktop/src-tauri/capabilities/browser.json` (or equivalent second file); tests that (1) `default` uses `webviews` not `windows` for `main`/`activity`/`dictation`, (2) no file under `capabilities/**/*` grants `windows` matching `main` without a tight `webviews` list, (3) every **existing** `invoke_handler` command (including `focus_main_window`, `open_external_url`, and every `dictation_*` the overlay uses) is allowed on **all three** of `main`/`activity`/`dictation`, (4) `browser_*` appears only on `main`
- **Depends on:** none
- **Changes:** Adding *any* app permission file sets `has_app_acl_manifest`; this PR must therefore list the full current command surface or the app breaks. Keep **one** capability for existing commands on `"webviews": ["main", "activity", "dictation"]` — do **not** invent an activity/dictation subset. Add a **second** capability for `browser_*` on `"webviews": ["main"]` only (empty/stub until PR 3 fills the commands). Switch `"windows"` to `"webviews"` (activity/dictation webview labels already match their window labels). Comment why `windows: ["main"]` is forbidden once children exist. No child webview yet. No user-visible behavior if the allow-list is complete. The "every command has an allow on `main`" test is necessary but **not sufficient** — activity and dictation must keep `focus_main_window`, `open_external_url`, and `dictation_*`.

### PR 2 — Link router helper + interceptor modifiers (no Settings toggle)

- **Title:** Route desktop http(s) clicks through a pure in-app/system helper
- **Files:** `apps/desktop/src/browser-link-routing.ts` (+ tests); `apps/desktop/src/external-links.ts` / `.test.ts` (`shouldHandleClick` passes `metaKey`/`altKey`/`button`); `packages/chat-ui/src/lib/web-link-context.tsx` (+ tests) — extra "Open in System Browser" row, `itemCount` not hardcoded at 2, remote-web unchanged when no extra item
- **Depends on:** none (parallel to PR 1)
- **Changes:** `resolveUrlOpenTarget`. In-app branch is a callback the host supplies later; until PR 5 it is unused. **Do not** wrap `openExternalUrl`. **Do not** add the General Settings switch yet (it would be a no-op, and `http:` cannot fall back to the system opener). PluginsView / RemotePairingPopover stay on `openExternalUrl` with no file changes required in this PR.

### PR 3 — Native `DesktopBrowserManager` with v1 security policy

- **Title:** Add a hardened Tauri child-webview manager
- **Files:** `apps/desktop/src-tauri/Cargo.toml` (`unstable`); `apps/desktop/src-tauri/src/browser.rs`; `apps/desktop/src-tauri/src/lib.rs` (`invoke_handler`, `on_web_content_process_terminate` skip/reload split, `DesktopState`); `capabilities/browser.json` (`browser_*` allows on `main` only); Rust unit tests for scheme / app-origin / 4123-always-deny / private-network / per-webview one-shot allow; integration note: child `fd-browser-*` cannot invoke `ensure_daemon_running` or `open_external_url` on a remote URL **or** on `http://localhost:1420` / `tauri://localhost`; after `harden_child`, `window.open` still emits `falcondeck://browser-open-tab` and `<input type=file>` still opens `NSOpenPanel`
- **Depends on:** PR 1
- **Changes:** `add_child`; `harden_child` (removeAllUserScripts, **remove ipc handler**, **wrap** wry UIDelegate → Deny media/geo/notifications without replacing popup/file-picker, `WKContentRuleList` compile blocking literals/`localhost`/RFC1918, **unconditional 4123**, and `ipc:`/`tauri:`/`asset:`/`ipc.localhost`); macOS 14 hard error; one-shot navigation allow keyed `(webview_label, url)`, never for port 4123; `on_navigation` closed over `tab_id`; `on_new_window` Deny + emit `falcondeck://browser-open-tab` with 3/10s rate limit; crash → state event, no reload; deny downloads for now; `devtools(cfg!(debug_assertions))`. **No** `core:webview:allow-create-webview`. **No** React chrome yet — but any debug attach uses `harden_child`. Shared incognito **data store** (not configuration) can be created here even if the product profile ships in PR 7.

### PR 4 — One-tab chrome + shell width + visibility coordinator + key monitor

- **Title:** Show an in-app browser tab in the desktop rail
- **Files:** `apps/desktop/src/components/browser/*`; `apps/desktop/src/App.tsx`; `apps/desktop/src/components/DesktopShell.tsx`; `packages/ui/src/components/resizable-shell.tsx` (`railMinSize`, `onRailSizeChange`, imperative resize without remounting `id="rail"`); `apps/desktop/src/api.ts`; `apps/desktop/src/shortcuts.ts` (`toggleBrowser` + push `browser_set_shortcut_bindings` on change); `packages/chat-ui` command palette `extraActions`; native `NSEvent` local monitor in `browser.rs` / a small `browser_keys.rs`; visibility coordinator
- **Depends on:** PR 3
- **Changes:** Review | Browser switcher. Address bar, back/forward/reload via manager (async, main-thread WKWebView). Persist `reviewRailWidth` / `browserRailWidth`; snap + hide native view during the snap. Coordinator hide list as specified (palette, `aria-modal`, main views, extension tool detail, rail close, live-resize, width animation, `coverNativeBrowser` for `MenuSurface`). Consume `falcondeck://browser-open-tab` by opening a **minimal extra tab** (enough for OAuth popups; full strip in PR 6). `NSEvent` monitor for `page` focus matches the **live** binding table (`browser_set_shortcut_bindings` from `falcondeck.desktop.shortcuts.v1`); hits emit `falcondeck://browser-shortcut` to `main`. Palette extra actions. macOS < 14: EmptyState, no attach. **Still no default-open of chat links, and no Settings toggle until attach actually works** — the toggle may appear here once `browser_os_version_supports_browser` is true, default on, wired to localStorage only.

### PR 5 — Default-open chat links in-app

- **Title:** Open chat http(s) links in the FalconDeck browser
- **Files:** `apps/desktop/src/App.tsx`; `apps/desktop/src/external-links.ts`; `apps/desktop/src/browser-link-routing.ts`; `apps/desktop/src/components/settings/GeneralSettingsPanel.tsx` (show the switch if not already shown in PR 4); tests. **Not** PluginsView.tsx / RemotePairingPopover.tsx
- **Depends on:** PR 2, PR 3, PR 4
- **Changes:** In-app branch calls `showRail()` + Browser + attach/navigate (one-shot allow happens in the command). ⌘-click and the context-menu item force system browser. `http:` in-app allowed under policy; `http:` system path still rejected. Preference honored only when the manager + macOS 14 are available.

### PR 6 — Multi-tab strip, persistence, live-view cap

- **Title:** Multi-tab in-app browser with inactive-view retention
- **Files:** `BrowserTabStrip.tsx`; tab state module + tests (LRU cap 6, persist/restore, skip incognito restore); `browser.rs`; `shortcuts.ts` + `KeyboardShortcutsPanel` for `newBrowserTab` / `closeBrowserTab` / `focusBrowserAddress` / `reloadBrowserTab` scoped to `chrome | page`
- **Depends on:** PR 4
- **Changes:** Full tab strip, persistence `falcondeck.desktop.browser.v1`, middle-click → background tab, cap 6. Popup consumer already existed in PR 4; this polishes it.

### PR 7 — Shared incognito profile

- **Title:** Shared incognito session for the in-app browser
- **Files:** `browser.rs` (manager-owned `WKWebsiteDataStore::nonPersistentDataStore()`, **new** `WKWebViewConfiguration` per tab with `setWebsiteDataStore`; not per-view `incognito(true)`, not a reused configuration); profile chip; ⌥-click routing; persist skip; confirm-on-last-close; tests: two incognito tabs share a cookie; second attach does **not** restore `window.ipc` on the first
- **Depends on:** PR 6
- **Changes:** One ephemeral **data store** shared among incognito tabs; dropped when the last view dies. Each tab still gets its own configuration so wry does not re-inject IPC.

### PR 8 — Downloads save panel (Phase 1.1 / same release if cheap)

- **Title:** In-app browser downloads via a save dialog
- **Files:** `browser.rs` (`on_download`); `capabilities/default.json` (`dialog:allow-save` on main); download toast; optional Settings downloads folder later
- **Depends on:** PR 4
- **Changes:** Always-ask save panel. Until this PR, downloads stay denied. Popup rate-limit and content rules already landed in PR 3 — do not wait for this PR to ship default-open.

### PR 9 — Settings → Browser + clear data

- **Title:** Browser settings: profiles and clear data
- **Files:** `settings-utils.ts` (`SettingsSectionId` + `Globe` nav); `BrowserSettingsPanel.tsx`; `SettingsView.tsx`; tests
- **Depends on:** PR 5, PR 7
- **Changes:** Dedicated section for profiles / clear data / (later) import. **Does not move** the General routing switch; links to it. Both gated on macOS 14 + manager.

### PR 10 — Per-project profiles (phase 2)

- **Title:** Per-project in-app browser profiles
- **Files:** profile registry; `data_store_identifier` from `workspace_id`; picker; `browser_set_profile`
- **Depends on:** PR 9
- **Changes:** App-wide `falcondeck` remains default.

### PR 11 — Cookie file import (phase 3)

- **Title:** Import cookies into a FalconDeck browser profile from a file
- **Files:** Netscape/JSON parser + `Webview::set_cookie`; Settings button; fixture tests
- **Depends on:** PR 9
- **Changes:** User-picked file only. No password import. No v1 command named `browser_import_cookies` until this PR.

### PR 12 — Best-effort Chrome import (phase 3)

- **Title:** Attempt Chrome cookie import and explain app-bound encryption
- **Files:** Chrome Cookies SQLite + Keychain path; Settings copy; synthetic v10 vs app-bound tests
- **Depends on:** PR 11
- **Changes:** Honest failure on Chrome 127+. Never touch `Login Data`.

### PR 13 — Agent-control docs only (phase 4)

- **Title:** Document that in-app WKWebView is not computer-use
- **Files:** `docs/COMPUTER-USE.md` (one sentence: in-app WKWebView is not a cua-driver target); optional pointer in this design
- **Depends on:** none (can land anytime after PR 1 conceptually; no runtime)
- **Changes:** No `DaemonCapabilities.browser_automation`. No `automationOwned` RPC. Optional `automationOwned: false` on the tab struct only if PR 6 wants it for forward compatibility.

PRs 10–12 are not v1. PR 8 is v1-adjacent. **Do not ship a release that default-opens untrusted pages without PRs 1, 3, and 4.**

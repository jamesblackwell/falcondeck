# FalconDeck notes for cua-driver

FalconDeck-authored host notes. The sibling skill files are vendored verbatim
from the cua-driver release named in `VERSION`; this file is not.

## Browser windows, cookies, and connection reuse

For routine browser work, prefer one dedicated **normal window in the user's
existing browser profile**, with their signed-in browser consent enabled in
FalconDeck. A normal window shares that profile's cookies, storage, extensions,
and site logins. An incognito window or driver-owned isolated profile does not
share those logins. Honor the user's requested browser, profile, window, or tab;
when they ask to act on an existing page, use that page.

1. Discover the requested browser and an observed window in the intended
   profile with `list_apps`, `list_windows`, and `get_window_state`. Never
   choose a different profile just because its window appears first.
2. Unless the task names an existing target, create one normal window using
   the native `invoke_menu` tool on that exact source `(pid, window_id)`, with
   the observed File → New Window menu path. Compare `list_windows` before and
   after, inspect the new window, and use its returned id. This is a native
   menu action and may briefly activate Chrome; focus restoration is
   best-effort. Do not use incognito, `creates_new_application_instance`,
   shell launch flags, or global keyboard shortcuts to create this window.
3. Bind the new window with `get_browser_state`. If binding requires setup or
   consent, use `browser_prepare` with that exact pid/window and
   `strategy: {kind: "existing_profile"}`, then bind again. Preparation belongs
   to cua-driver's approved setup flow; do not toggle browser settings or
   click consent UI yourself.
4. Keep that window, the same MCP connection, and one task-specific `session`
   label for preparation, binding, page actions, and verification. Repeat the
   label on every tool that accepts it. Re-snapshot for fresh refs rather than
   starting another session, preparing again, or opening another window for
   each action. Do not end the session between actions; end it when the browser
   task is finished and check cleanup results.

Chrome's debugging connection applies to the profile, not just this window.
Chrome may show its control banner in other windows of the same profile, and
a genuinely new browser-level connection can require another Chrome consent
prompt. Window separation protects the user's tabs; retaining the connection
reduces repeated setup and prompts. It cannot guarantee a banner-free browser.
The five-minute idle session expiry, transport close, browser restart, or
revocation can still require preparation and fresh binding. Do not keep a
session alive artificially or suppress Chrome's indicators.

Keep concurrent tasks on separate windows and separate MCP lifecycles. This
does not isolate profile-wide state or global focus; avoid concurrent native
input. Never copy personal cookies/profile files into an isolated instance.
Use an isolated profile only when the user requests it or signed-out operation
satisfies the task. If signed-in consent is denied, ask the user to enable it
instead of silently changing profiles or bypassing the grant.

## An isolated browser launch may not use the browser the user expects

`browser_prepare` with `allow_launch: true` and no `pid` only accepts a
platform-attested system install. On macOS it tries Google Chrome first, then
Microsoft Edge, and it attests the installed bundle, not just the signature of
the executable.

A Chrome that the user drag-installed is usually owned by that user, is
group-writable, and carries `com.apple.FinderInfo` attributes, so it fails
attestation. The driver then falls through to Edge without saying why. On a Mac
with no Edge, the same launch fails with `no vendor-signed system Chromium
executable is available for isolated launch`.

Pass the pid of a running instance of the browser you want, and the driver uses
that process's exact executable:

```bash
cua-driver browser_prepare \
  '{"session":"qa-run-1","allow_launch":true,"pid":44349,
    "profile":{"mode":"isolated_new"}}'
```

Find the pid with `list_apps` or `list_windows`. Launch the browser first with
`launch_app` if it is not running. Attaching to a signed-in profile already
requires a pid and window id, so it is unaffected.

Tell the user which browser a run actually used whenever it is not the one they
named, and offer the pid route rather than changing anything about their
install.

Diagnose an install that fails attestation with:

```bash
codesign --verify --strict "/Applications/Google Chrome.app"
ls -ld "/Applications/Google Chrome.app"
```

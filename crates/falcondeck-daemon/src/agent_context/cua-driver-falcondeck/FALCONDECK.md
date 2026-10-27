# FalconDeck notes for cua-driver

FalconDeck-authored host notes. The sibling skill files are vendored verbatim
from the cua-driver release named in `VERSION`; this file is not.

## Use the agent browser by default

FalconDeck gives agents their own persistent Chrome profile, the **agent
browser**. The user signs in to the sites agents need once, through
Settings → Computer use → **Open agent browser**, and those logins persist.
cua-driver launches it with its own debugging port, so Chrome never shows the
"Allow remote debugging?" prompt. Use it for every browser task unless the user
explicitly asks you to work in their own Chrome window or tab.

1. Find the pid of the user's own Chrome: the main `Google Chrome` process
   with no `--user-data-dir` or `--remote-debugging-port` flag
   (`for p in $(pgrep -x 'Google Chrome'); do ps -o args= -p $p | grep -q -e --user-data-dir -e --remote-debugging || echo $p; done`).
   Do not take the pid from `list_apps`: it can report an automation
   instance (Playwright, another cua profile) as Google Chrome. If the user's
   Chrome is not running, `launch_app` it first. The pid only pins which Chrome
   executable is used (see below); the personal profile is not touched.
   Starting the user's Chrome first also matters:
   macOS sends Dock clicks and opened links to an already-running Chrome
   process. If the agent browser is the only one running, the user's
   own launches land in it. Never quit the user's Chrome.
2. Launch the agent browser:

   ```text
   browser_prepare
     '{"session":"<task-label>","allow_launch":true,"pid":<chrome pid>,
       "profile":{"mode":"isolated_named","name":"falcondeck-agent"}}'
   ```

3. Check the result before binding. cua first reuses any debugging endpoint
   already open on the pid you passed, and then ignores `profile`. Continue
   only when `action` is `launched_isolated_browser`, or when the
   `prepared_pid` command line contains `BrowserProfiles/falcondeck-agent`.
   Otherwise you got a different browser: do not bind it, and tell the user.
   `list_windows` with the returned `prepared_pid`, then bind its window with
   `get_browser_state` and use the typed browser tools. Reuse that window,
   the same MCP connection, and one session label for the whole task.
4. End the session when the task is done. Ending it closes the agent browser
   process. Chrome writes new
   cookies to disk about every 30 seconds, so after a login or session
   refresh, keep working (or wait) briefly before ending.

Refusals and what they mean:

- `browser_route_unavailable` with "exited before exposing DevTools": the
  user has the agent browser open for signing in. Ask them to quit that Chrome
  (⌘Q in its window), then retry.
- `browser_endpoint_owner_mismatch`: another task is using the agent browser.
  Do not bind to its instance: it closes, with your tabs, when that task ends
  its session. Wait for it to exit, checking about every 30 seconds with
  `pgrep -f 'MacOS/Google Chrome --remote-debugging-port.*BrowserProfiles/falcondeck-agent'`
  (this skips Chrome's helper processes), then run `browser_prepare` again. If
  it is still running after about 10 minutes, tell the user instead of waiting
  longer.
- A site shows a login page: end your browser session first, which closes the
  agent browser. Then ask the user to sign in through Settings → Computer use
  → Open agent browser and quit that Chrome (⌘Q) when done. Launch again after
  they confirm. While an agent's instance is running, FalconDeck refuses to
  open the sign-in window, because the user's ⌘Q would also close the agent's
  browser. Do not ask for or type the user's password, copy cookies, or switch
  to the personal profile.

Every launch may show a small "Restore pages?" bubble because the previous run
was closed abruptly. Ignore it; it does not block page tools.

## The user's personal Chrome profile (opt-in only)

Attach to the user's own profile (`strategy: {kind: "existing_profile"}`) only
when they explicitly ask you to act in their own browser window or tab and
Settings → Computer use → "Allow agents to use my personal Chrome profile" is
on. Each new connection there makes Chrome ask the user to allow remote
debugging, which is the prompt the agent browser exists to avoid. If the
setting is off, tell the user rather than working around it.

When you do use it, discover an observed window in the intended profile with
`list_apps`, `list_windows`, and `get_window_state`, and use the page the user
named. Otherwise create one normal window with the native `invoke_menu` tool on
that exact source `(pid, window_id)` (File → New Window), compare
`list_windows` before and after, and bind the new window with
`get_browser_state`. Use `browser_prepare` with that exact pid/window and
`strategy: {kind: "existing_profile"}` only if binding requires setup or
consent; do not toggle browser settings or click consent UI yourself. Keep the
window, MCP connection, and session label for the whole task so Chrome does
not prompt again.

Keep browser work in the background. Prefer typed browser tools with explicit
`input_route: "dom_event"` clicks where supported, and verify the resulting
page state. If an action requires foreground input, report it before switching
focus; do not automatically retry with foreground delivery. Never copy personal
cookies or profile files into another profile.

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

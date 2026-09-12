# FalconDeck notes for cua-driver

FalconDeck-authored host notes. The sibling `SKILL.md`, `MACOS.md`,
`BROWSER.md`, `RECORDING.md`, and `README.md` are vendored verbatim from the
cua-driver release named in `VERSION`; this file is not.

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

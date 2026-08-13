# Mini Zen

Mini Zen is FalconDeck's official proof extension for full-main-area panels.
It listens to bounded attention lifecycle events, retains a private queue, and
publishes a declarative panel that focuses on one pending item at a time. With
an explicit `threads:read` grant it can show the matching thread title; before
the grant it keeps working with identifier-only counts and a generic label.

The extension is bundled but disabled by default. It uses only
`@falcondeck/extension-sdk`; clients render its synchronized declarative view
without executing extension code.

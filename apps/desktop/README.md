# FalconDeck Desktop

The macOS app is a Tauri shell around the FalconDeck daemon. React renders the
interface; the daemon owns agent processes, turn execution, and remote connections.
Shared UI lives in `packages/ui` and `packages/chat-ui`.

## Develop

Run commands from the repository root. Install Node.js/npm, Rust stable, and
Xcode command line tools with Swift 6.2 or later for the bundled speech helper.

```sh
npm install
make desktop-dev
```

The frontend runs at `http://localhost:1420`. To run only the frontend against
an existing daemon, use `make frontend-dev`.

## Check changes

```sh
npm run typecheck --workspace falcondeck-desktop
npm run lint --workspace falcondeck-desktop
npm run test --workspace falcondeck-desktop
cargo test -p falcondeck-daemon
```

Run the checks relevant to your change. Read [the design system](../../DESIGN.md)
before changing shared UI or branding.

## Build and install

```sh
make desktop-install
```

This builds, installs, and starts the packaged Mac app, then checks daemon
health. Icon generation requires ImageMagick's `magick` command. To restart an
already installed app without rebuilding, use `make desktop-restart`.

See [desktop releases](../../docs/13-desktop-updates.md) for signing and updater
configuration, [dictation](../../docs/18-desktop-dictation.md) for speech
features, and [the documentation index](../../docs/README.md) for other guides.

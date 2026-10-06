# Get started with FalconDeck

FalconDeck gives Codex, Claude Code, OpenCode, and other coding agents a comfortable Mac workspace. Run a first task on your Mac, then optionally connect your iPhone or iPad to follow the same work away from your desk.

## What you need

- A Mac running macOS 12 or later, with Apple Silicon or Intel.
- A supported coding agent and its account or model access. FalconDeck uses your existing agent login; it does not include an AI subscription.
- An internet connection for agents that use hosted models and for remote access.

FalconDeck and its hosted relay are free. You can use the Mac app on its own.

## Run your first task

1. [Download the latest Mac release](https://github.com/jamesblackwell/falcondeck/releases/latest). Choose the `aarch64.dmg` for Apple Silicon or `x64.dmg` for Intel. Open the DMG, drag FalconDeck into Applications, and launch it.
2. Follow setup to check your coding tools and choose a project folder. If your agent is not installed, setup offers installation for supported tools. Sign in to the agent with the account you normally use.
3. Start a new task in that project and choose your agent. For a simple first try, ask: **“Explain this project's structure and how to run its tests. Don't change any files.”**
4. Follow the response and tool activity. When the agent asks a question or requests permission, respond from the same conversation.

Your project stays in its existing folder. You can keep using your editor alongside FalconDeck.

## Connect your iPhone or iPad

1. [Install the free iOS app](https://apps.apple.com/app/falcondeck/id6760899257).
2. In the Mac app, open **Settings → Remote Access → Start Pairing**.
3. Scan the QR code using the iOS app's pairing screen. If a code expires, generate a fresh one on your Mac.
4. Open your project on your phone. You can read responses, answer questions, approve actions, and send the next instruction.

No FalconDeck account is required. Your Mac must stay awake, online, and running FalconDeck for work hosted on that Mac to continue. For an always-on setup, you can [run agents on another machine over SSH](REMOTE-HOSTS.md).

## Common questions

**Can I use FalconDeck without a phone?** Yes. The Mac app is a complete workspace; mobile access is optional.

**Do I need to move my code or switch editors?** No. Connect an existing project folder and keep using your preferred editor. FalconDeck provides the workspace for your agent tasks.

**Does my existing agent subscription work?** FalconDeck runs your installed coding tools and uses their authentication and model access. Availability and billing depend on the agent and provider you choose.

**Where does my work live?** Code remains in your project folders. The underlying agents own their sessions. Remote session content is end-to-end encrypted between your paired devices, and you can [self-host the relay](SELF-HOSTING.md).

**Which platforms can I download?** Packaged apps are available for Mac, iPhone, and iPad. Android can be built from the [mobile source](14-mobile-app.md). The [remote web client](../apps/remote-web/README.md) is also available from source.

## If you get stuck

- If an agent is missing or signed out, check **Settings → Agents** and the agent's own sign-in instructions.
- If pairing fails, check that your Mac is online, generate a fresh QR code, and try again.
- [Ask a question or share feedback in Discussions](https://github.com/jamesblackwell/falcondeck/discussions).
- [Report a reproducible bug](https://github.com/jamesblackwell/falcondeck/issues/new/choose), including your app version, macOS/iOS version, agent, and what happened.

FalconDeck is actively developed and used for daily work. Feedback from real projects helps make the next release better.

## Continuing sessions after restart

New installs automatically continue non-archived sessions interrupted when
FalconDeck closes. The daemon restores each saved native agent session in the
background with its existing model and permission settings. Completed sessions
and sessions stopped by the user remain stopped.

Use **Settings → General → Startup → Automatically continue stopped sessions**
to change this behaviour. Existing installs retain the startup recovery dialog
until they opt in; check **Automatically continue stopped sessions when
FalconDeck starts** and choose **Continue all** to save the setting. A failed
resume leaves the session's recovery notice available for a manual retry.

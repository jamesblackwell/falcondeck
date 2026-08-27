# App Store Listing

Source of truth for the FalconDeck iOS listing and App Review submission. Copy
these fields into App Store Connect verbatim. Update this file first, then the
listing, so the two never drift.

Field limits: name 30, subtitle 30, promotional text 170, keywords 100,
description 4000.

## Name and subtitle

**Name:** `FalconDeck`

**Subtitle (23):** `Coding agents on the go`

Third-party agent names are deliberately kept out of the name, subtitle, and
keywords. Competing apps do put "Claude Code" and "Codex" in their app name and
have shipped, but trademarked terms in those fields invite a 4.1 or 5.2.1
review, and the description carries the same discovery value without the risk.

## Promotional text (109)

```
Start, steer, approve, and review coding agents from your phone. End-to-end encrypted, open source, and free.
```

## Keywords (91)

```
coding agent,ai coding,remote,terminal,cli,diff,voice,developer,pair,devtools,agents,review
```

## Description

App Store Connect preserves line breaks literally, so paragraphs are single
long lines here on purpose. Do not re-wrap them when pasting.

```
Keep your coding agents moving when you are away. FalconDeck lets you follow live work, answer questions, approve actions, review changes, and send the next instruction from your phone. Pick up the same session on your Mac whenever you are ready.

FalconDeck is not affiliated with Anthropic, OpenAI, or Google.

Want to see the interface first? Tap "Explore demo workspace" on the welcome screen. It opens a sample workspace with no pairing, no account, and no network.

WHAT YOU CAN DO
- Keep coding-agent sessions running on your own Mac within reach from your phone
- Pick up live sessions from Codex, Claude Code, OpenCode, or other ACP-compatible agents you already use
- Get a push the moment an agent needs you — a permission request, a question, or a finished turn
- Approve or decline a tool call before anything runs on your machine
- Read changes as a proper file-by-file diff, not a wall of terminal output
- Dictate a prompt by voice, on-device or through the transcription provider you configure
- Attach a screenshot or photo to a prompt
- Have long responses read aloud, including when the screen is off
- Change agent, model, and reasoning effort per turn
- Queue follow-ups and steer a turn while it is still running
- Move between projects and threads from one sidebar, and pin, rename, or archive as you go

HOW IT WORKS
1. Run FalconDeck on your Mac and open a project
2. Scan the pairing QR code with your phone
3. Your phone joins the same live session — same repository, tools, and context
4. Continue from your Mac or phone whenever you want

PRIVACY
Session content is end-to-end encrypted between your own devices. The relay that connects them moves sealed ciphertext and holds the keys to none of it, so your prompts, code, and agent output are unreadable to us in transit and at rest. Nothing is used for advertising or model training. If you would rather not use our relay at all, the whole thing is self-hostable.

OPEN SOURCE
The app, the desktop daemon, and the relay are all public and MIT licensed. Read the encryption, audit the protocol, or run your own: https://github.com/jamesblackwell/falcondeck

BUILT FOR
- Developers running long agent tasks who do not want to sit and watch them
- Anyone who has lost twenty minutes because an agent stopped on a permission prompt two minutes in
- People who care where their code goes

Privacy Policy: https://falcondeck.com/privacy
Terms of Use: https://falcondeck.com/terms
```

## Notes for App Review

Guideline 2.3.1 rejects generic review notes, so this stays specific. Paste as
written and keep the demo steps accurate against the shipped build.

```
HOW TO REVIEW THE APP

FalconDeck includes a fully interactive built-in demo workspace. It requires
no sign-in, pairing, desktop setup, or network connection:

1. Launch FalconDeck
2. On the welcome screen, tap "Explore demo workspace"

This opens a sample workspace with two conversations, assistant responses,
tool calls, command output, and file diffs. Sending a message receives a
clearly labelled simulated reply after a short delay. A banner at the top
identifies the demo and provides a route back to pairing.

To leave demo mode, tap "Pair a desktop" in that banner.

HOW FALCONDECK WORKS

FalconDeck is a native iOS interface for following and steering coding-agent
sessions. In ordinary use, a user pairs their phone with a FalconDeck agent
session running in their own development environment. The Mac handles agent
execution; the iOS app shows the live session, lets the user send instructions,
and lets them respond to approval prompts.

No code is downloaded, interpreted, or executed on the iOS device. This is not
a remote desktop or screen-mirroring app: there is no host-screen streaming and
the iOS interface is native.

ABOUT THE PAIRING SCREEN

"Scan QR code" requests camera access only to pair with a user's own Mac. With
no Mac available, use "Explore demo workspace" instead. Declining camera
access returns to the welcome screen and retains demo mode.

"Self-hosted relay settings" is only for people using their own relay server;
normal use requires no configuration.

PERMISSIONS
- Camera: scanning the desktop pairing QR code
- Microphone and speech recognition: optional voice dictation of prompts
- Photos: optionally attaching an image to a prompt
- Notifications: alerting the user when an agent needs a decision
- Background audio: continuing read-aloud playback when the screen is off

None are requested at launch. Each is requested at the point of use and the
app is fully usable if all are declined.

BUSINESS MODEL
The app is free with no in-app purchases and contains no purchase prompts or
links to buy anything.

OPEN SOURCE
https://github.com/jamesblackwell/falcondeck
Privacy Policy: https://falcondeck.com/privacy
```

## Screenshots

Use four iPhone portraits in this order. The marketing shell is deliberately
plain: a flat `#09090b` canvas, `#f4f4f6` heading, no public logo or tagline,
and one front-on app screen window. The screen inside it is FalconDeck's actual
iOS interface. Keep it readable; marketing overlays may highlight it but must
not obscure it.

1. "Keep work moving / from anywhere" — conversation with agent output and tool call
2. "Every project / one place" — projects and thread sidebar
3. "Connect to your / desktop agent" — QR and secure-code pairing
4. "Stay in control / on the go" — settings

Do not show the demo banner, sample-workspace call to action, self-hosted relay
controls, or any "simulated" wording in product-page screenshots. Those exist
for App Review, and are explained in the review notes, rather than being a
customer-facing feature claim.

First-pass iPhone candidates live in `docs/app-store-assets/iphone-6.9/`.
They are PNG, opaque, and exactly 1290 x 2796 pixels: an accepted 6.9-inch
portrait target. App Store Connect scales this required size for smaller
iPhones, so we do not need a separate set for every iPhone model.

FalconDeck currently supports iPad, so App Store Connect also requires at
least one 13-inch iPad screenshot. The truthful native iPad pairing and demo
entry capture is `docs/app-store-assets/ipad-13/01-demo-entry.jpg`, at the
required 2064 x 2752 pixels. More iPad screenshots are optional.

Apple allows one to ten JPEG or PNG screenshots per device family and does not
allow alpha/transparency. Review all generated compositions against the
shipped build before upload: device frames and captions are fine, but the
underlying screen must accurately represent the app. Do not include desktop or
another platform's UI (Guideline 2.3.10).

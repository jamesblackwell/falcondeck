# Desktop Dictation

FalconDeck provides system-wide dictation while the macOS desktop app is
running. The daemon remains responsible for cloud transcription credentials;
the desktop shell owns global keyboard input, microphone capture, the floating
status window, and paste-at-cursor behavior.

## MVP behavior

- Dictation is off until the user enables it in onboarding or Settings →
  Speech.
- Right Command is the default trigger. Left Function is suggested beside
  it. Settings and onboarding can record any other shortcut (F13, a chord
  such as ⌘⇧D, Caps Lock, Left Command). Modifier-only keys still hold to
  talk without stealing Command-C; chords are swallowed so they do not type
  into the focused app.
- Voice rewrite is a second, off-by-default mode. Select text, hold Right
  Option (configurable), and speak how to edit it. FalconDeck rewrites through
  OpenRouter (default GPT-5.6 Luna) and pastes over the selection.
- Hold mode waits 180 ms before recording and cancels if another key is pressed,
  so ordinary modifier shortcuts continue to work. Toggle mode starts and stops
  on modifier-only presses.
- Escape cancels an active recording.
- The overlay is a native non-activating panel. It follows the pointer's current
  display and sits at the top of its work area; its Copy, Retry, Discard, and
  Undo controls work without raising FalconDeck or stealing the destination's
  focus.
- Apple Speech is the zero-key default and uses the user's current macOS
  language. OpenRouter is optional and uses the existing daemon speech API and
  credential store.
- A transcript must contain at least three characters before FalconDeck treats
  it as confirmed.
- Cross-application insertion uses the destination's normal Command-V path.
  Accessibility selected-text writes are not treated as delivery because
  controlled web editors can report success without updating their state.
- FalconDeck snapshots every pasteboard item and type, marks its transcript as
  transient, waits briefly for the pasteboard server, and sends a complete
  Command-down/V-down/V-up/Command-up sequence using the current keyboard
  layout. It restores the prior clipboard after 1.5 seconds only while its
  recorded pasteboard change count proves that it still owns the contents. A
  user or clipboard manager change always wins.
- The captured destination is checked immediately before the shortcut. If the
  FalconDeck overlay briefly became active, the original app is reactivated;
  if the user switched to a different app, insertion stops and the transcript
  is offered for Copy instead of being pasted into the wrong place.
- A completed transcript remains in the top pill for eight seconds with a Copy
  action. Explicit copy leaves the transcript on the clipboard; automatic paste
  still restores the clipboard contents it temporarily replaced.
- If the destination cannot accept the paste, the overlay grows into a recovery
  card: the transcript is shown as plain text (not a quotation), with Copy as
  the primary action and Retry/Discard still available. The window is sized to
  keep those controls on-screen.

## Native flow

The Tauri shell builds a small Objective-C bridge against AppKit,
AVFoundation, ApplicationServices, and Speech. The bridge:

1. listens for modifier-only key transitions using a session event tap;
2. records one-channel AAC audio from the selected `AVCaptureDevice` to a
   unique file in the macOS temporary directory;
3. sends lifecycle events to the Rust shell;
4. transcribes with `SFSpeechURLRecognitionRequest`, or hands the temporary file
   to Rust for the daemon's OpenRouter endpoint;
5. revalidates the captured frontmost application, stages an ownership-tagged
   transient clipboard item, and synthesizes a normally routed Command-V
   without targeting a possibly stale process ID.

FalconDeck inserts directly into its own React composer rather than routing its
transcript back through the native paste machinery. For external apps, macOS
does not expose an acknowledgement that an editor consumed a synthetic paste;
the completed pill therefore retains the transcript and its Copy action for
eight seconds even after the shortcut was dispatched.

Microphone selection is independent of the macOS output route. FalconDeck uses
an input-only `AVCaptureSession`, so starting dictation does not create a
playback audio session, pause other apps, or change their output device. A
persisted device unique ID selects a particular microphone; if that device is
disconnected, capture falls back to the current system input without discarding
the preference.

OpenRouter dictation requires macOS 10.14 or later. Apple Speech requires
macOS 10.15 or later. The native bridge checks those versions at runtime so the
desktop app can retain its older deployment target without unguarded SDK calls.

The Rust shell validates temporary paths before reading them, limits OpenRouter
recordings to 8 MiB, and never exposes the OpenRouter credential to the
webview.

For the strongest stable local identity, set
`FALCONDECK_LOCAL_CODESIGN_IDENTITY` to a certificate shown by
`security find-identity -v -p codesigning` before running
`make desktop-install`. When no identity is configured, local packaged builds
fall back to an ad-hoc designated requirement derived from
`CFBundleIdentifier`. Without an explicit stable requirement, macOS uses the
executable's changing code hash as its identity and an enabled Accessibility
entry can become stale after every install.

The identifier-only ad-hoc fallback is intended only for trusted local
development machines. Another locally run binary can claim the same bundle
identifier, so release builds and shared development machines should use a
certificate-backed signing identity.

After switching an existing local installation to the stable requirement,
reset Accessibility once with
`tccutil reset Accessibility com.falcondeck.desktop`, reinstall, then enable
FalconDeck again in System Settings and relaunch it. Later local rebuilds keep
the same permission identity.

## Retention and recovery

The current temporary recording is stored in macOS user defaults only as a file
path. The audio itself stays in the temporary directory.

- Successful transcription and paste deletes the file and clears the retained
  path.
- Cancellation and explicit discard delete it immediately.
- Empty transcription, provider failure, or paste failure keeps it available
  for Retry or Discard.
- FalconDeck refuses to overwrite a retained failed recording with a new one.

No transcript history or raw-audio library is created in the MVP.

## Permissions

macOS requires Microphone and Accessibility access. Apple Speech also requires
Speech Recognition access. Onboarding and Settings expose the current status
and request these permissions only after the user enables or configures
dictation.

The Accessibility permission is used for global shortcut observation and the
synthetic paste. FalconDeck re-attempts event-tap installation when the app
becomes active again after the user changes System Settings.

## Follow-ups

Voice rewrite of selected text is a separate, off-by-default mode: select
text, hold a different shortcut (Right Option by default), and speak an
instruction such as "polish this in my style, but fix any grammar issues."
FalconDeck captures the selection through Accessibility when the focused
editor exposes it, otherwise by a snapshot-and-restore Command-C, transcribes
the instruction with the same engine as dictation, then rewrites through
OpenRouter (default `openai/gpt-5.6-luna`, with faster options such as
`openai/gpt-oss-120b`) using the existing speech API key. Settings → Speech
has a Custom prompt control that opens pre-filled with the built-in system
prompt; Reset restores that original.
The rewritten text is delivered with the same Command-V paste path as
dictation. Empty selections fail instead of typing the instruction. The model
is told to treat the passage as material to edit, never as a question to
answer, and not to polish it into generic LLM prose.

Local downloaded models, vocabulary/dictionary hints, learned writing-style
profiles, and Windows support are deliberately outside this version. A local
model should plug into the same post-recording provider boundary without
moving durable conversation state into the desktop shell.

## Manual verification

1. Enable dictation with Apple Speech and grant all three macOS permissions.
2. Hold Right Command alone, dictate into TextEdit, release, and confirm the
   text is pasted while the original clipboard returns.
3. Repeat in a browser editor, a terminal, and a React-controlled composer;
   confirm each receives the text through its ordinary paste behavior.
4. Start dictation in one app, switch to a different app while it transcribes,
   and confirm FalconDeck offers Copy without pasting into the new app.
5. Change the clipboard during the 1.5-second restore window and confirm
   FalconDeck preserves the newer clipboard contents.
6. Use Command-C and another slow Command shortcut; confirm neither produces a
   transcript.
7. Record and press Escape; confirm no text is pasted and no retry remains.
8. Force a transcription failure, relaunch FalconDeck, and confirm the next
   attempt offers Retry or Discard instead of overwriting the audio.
9. Select OpenRouter, save a key, choose a transcription model, and repeat the
   TextEdit flow.
10. Click Copy on a completed pill while another app is frontmost; confirm the
    transcript reaches the clipboard without FalconDeck coming to the front.
11. Enable Voice rewrite, keep Right Option as the shortcut, select a sentence
    in TextEdit, hold Right Option, say "make this shorter", and confirm the
    selection is replaced rather than appended.
12. Hold Right Option with nothing selected and confirm FalconDeck offers an
    error instead of pasting the spoken instruction.
13. Repeat the rewrite in a browser editor and in FalconDeck's own composer;
    confirm each replaces the live selection through ordinary paste / insert.

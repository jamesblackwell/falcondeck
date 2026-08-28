# Desktop Dictation

FalconDeck provides system-wide dictation while the macOS desktop app is
running. The daemon remains responsible for cloud transcription credentials;
the desktop shell owns global keyboard input, microphone capture, the floating
status window, and paste-at-cursor behavior.

## MVP behavior

- Dictation is off until the user enables it in onboarding or Settings →
  Speech.
- Right Command is the default trigger. Left Function is also available.
- Hold mode waits 180 ms before recording and cancels if another key is pressed,
  so ordinary modifier shortcuts continue to work. Toggle mode starts and stops
  on modifier-only presses.
- Escape cancels an active recording.
- The non-focusable overlay follows the pointer's current display and sits at
  the top of its work area, away from the FalconDeck composer.
- Apple Speech is the zero-key default and uses the user's current macOS
  language. OpenRouter is optional and uses the existing daemon speech API and
  credential store.
- A transcript must contain at least three characters before FalconDeck treats
  it as confirmed.
- When FalconDeck falls back to a targeted Command-V, it temporarily uses the
  system clipboard, then restores the previous contents if no other app changed
  them in the meantime.
- Some controlled web composers report a successful Accessibility edit without
  accepting it. FalconDeck bypasses that path for ChatGPT and sends its normal
  targeted Command-V paste instead.
- A completed transcript remains in the top pill for eight seconds with a Copy
  action. Explicit copy leaves the transcript on the clipboard; automatic paste
  still restores the clipboard contents it temporarily replaced.

## Native flow

The Tauri shell builds a small Objective-C bridge against AppKit,
AVFoundation, ApplicationServices, and Speech. The bridge:

1. listens for modifier-only key transitions using a session event tap;
2. records one-channel AAC audio from the selected `AVCaptureDevice` to a
   unique file in the macOS temporary directory;
3. sends lifecycle events to the Rust shell;
4. transcribes with `SFSpeechURLRecognitionRequest`, or hands the temporary file
   to Rust for the daemon's OpenRouter endpoint;
5. synthesizes Command-V without taking focus from the destination app.

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

Local downloaded models, vocabulary/dictionary hints, transcript history,
style cleanup, arbitrary multi-key shortcut recording, and Windows support are
deliberately outside this first version. A local model should plug into the
same post-recording provider boundary without moving durable conversation state
into the desktop shell.

## Manual verification

1. Enable dictation with Apple Speech and grant all three macOS permissions.
2. Hold Right Command alone, dictate into TextEdit, release, and confirm the
   text is pasted while the original clipboard returns.
3. Use Command-C and another slow Command shortcut; confirm neither produces a
   transcript.
4. Record and press Escape; confirm no text is pasted and no retry remains.
5. Force a transcription failure, relaunch FalconDeck, and confirm the next
   attempt offers Retry or Discard instead of overwriting the audio.
6. Select OpenRouter, save a key, choose a transcription model, and repeat the
   TextEdit flow.

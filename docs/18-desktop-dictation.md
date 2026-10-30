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
  Option (configurable), and optionally speak how to edit it. Silence, or a
  clip with no detected speech, tidies the selection. FalconDeck rewrites
  through OpenRouter (default GPT-5.6 Luna) and pastes over the selection.
  Settings loads a short fast-and-frontier model list from OpenRouter, caches
  it on this computer, and can send a reasoning effort with the rewrite.
- In hold mode, triple-tapping the rewrite shortcut tidies the whole focused
  field without recording: FalconDeck sends Command-A, captures the field with
  Command-C (falling back to Accessibility), and runs the same silent rewrite
  a quiet hold would. A rewrite press released within 300 ms is a tap: any
  take it started is discarded without Undo or an error, because the
  microphone is not warm that soon. Taps must release less than 600 ms apart;
  typing between taps resets the count. Nothing is filed to history. While an
  earlier take is still transcribing or rewriting the triple tap does nothing;
  a take waiting for Retry is shown again instead.
- A held recording is reported as waiting for Retry only when Rust is not
  still transcribing or rewriting it (`fd_dictation_busy`), so pressing a
  shortcut mid-transcription no longer replaces the progress pill with a
  failure.
- In hold mode the rewrite selection is read when the shortcut is released
  (Accessibility text primed at key-down, else Command-C), so starting a take
  never waits on the copy. Toggle mode still reads it before recording.
- Hold mode waits 80 ms before recording and cancels if another key is pressed,
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
- A completed transcript remains in the top pill for fifteen seconds with Copy,
  Update dictionary, and Fix actions. Explicit copy leaves the transcript on the
  clipboard; automatic paste
  still restores the clipboard contents it temporarily replaced.
- If the destination cannot accept the paste, the overlay grows into a recovery
  card: the transcript is shown as plain text (not a quotation), with Retry
  paste as the primary action (re-captures the live target and re-runs the
  paste without re-transcribing, trying a directly targeted Command-V before
  the normally routed one), Copy as the secondary action, and
  Retry transcription / Discard still available. The window is sized to
  keep those controls on-screen.

## Corrections after transcription

Settings → Voice → Correction dictionary stores up to 100 find/replace pairs
on this Mac. Entries match whole words or phrases without case sensitivity;
the replacement uses the saved spelling. Leave the replacement blank to remove
the matched word or phrase; saved removals appear as “(remove)” in the list.
Removal also closes the adjoining space without changing paragraph breaks.
When rules remove the entire transcript, the take completes as “Words removed”
without pasting, replacing the clipboard, or offering an older transcript. Longer phrases win and replacements
do not cascade through other entries. All engines use the dictionary before
delivery, including when cloud cleanup is disabled. Dictionary updates apply
to future transcriptions and history retries.

Update dictionary opens Voice settings with the latest transcript visible and
the Heard as field focused. Existing entries can be edited or removed.

Fix runs the selected rewrite model with the transcript-cleanup prompt, even
when automatic cleanup is off. It requires the daemon connection and the
existing OpenRouter speech key. Before replacing pasted text, FalconDeck
checks the recorded insertion range, current editor, current text, and caret
or selection. If that range cannot be verified (including editors with limited
Accessibility support), the corrected transcript remains in a recovery card.
Select the original passage and choose Paste correction, or copy the correction.
A failed model request keeps the original transcript available. Starting a new
dictation or dismissing the overlay retires an in-flight Fix.

## Native flow

The Tauri shell builds a small Objective-C bridge against AppKit,
AVFoundation, ApplicationServices, and Speech. The bridge:

1. listens for modifier-only key transitions using a session event tap;
2. records 16 kHz mono PCM audio from the selected `AVCaptureDevice` to a
   unique CAF file in the macOS temporary directory. CAF remains readable if
   the process exits before the writer closes. Before transcription, the
   bridge exports a compressed M4A, validates it, persists its recovery path,
   then deletes the CAF source;
3. sends lifecycle events to the Rust shell;
4. transcribes with `SFSpeechURLRecognitionRequest`, or hands the temporary file
   to Rust for the daemon's OpenRouter endpoint;
5. revalidates the captured frontmost application, stages an ownership-tagged
   transient clipboard item, and synthesizes a normally routed Command-V
   without targeting a possibly stale process ID. When the normal route
   cannot be delivered, it retries with a Command-V posted directly to the
   captured process; paste attempts also re-read the live AX focus first so a
   stale capture is reclassified as a same-app insert.

FalconDeck inserts directly into its own React composer rather than routing its
transcript back through the native paste machinery. For external apps, macOS
does not expose an acknowledgement that an editor consumed a synthetic paste;
the completed pill therefore retains the transcript and its Copy action for
fifteen seconds even after the shortcut was dispatched.

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

`make desktop-install` signs with `Developer ID Application: Version Zero Limited`
when that identity is in the login keychain, so Accessibility stays stable
across local rebuilds. Override with `FALCONDECK_LOCAL_CODESIGN_IDENTITY` if
needed. When no Developer ID is present, local packaged builds fall back to an
ad-hoc designated requirement derived from `CFBundleIdentifier`. Without a
stable requirement, macOS uses the executable's changing code hash as its
identity and an enabled Accessibility entry can become stale after every
install.

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

The current recording path and provider are persisted in macOS user defaults.
Audio remains in the macOS temporary directory. Capture uses PCM CAF because
an interrupted M4A writer leaves no finalized sample table (`moov`), even when
its file contains many bytes. The CAF stays available across an interrupted
capture or export; retry compresses it again before invoking the provider.
An orderly quit stops capture without treating it as a cancellation.

- Successful transcription and delivery clears the retained path. Recording
  history keeps the compressed audio for the configured retention window
  (six hours by default); with history disabled it is deleted immediately.
- Escape offers a ten-second Undo window, then deletes the cancelled take.
  Explicit discard deletes the retained take and cancels any active export.
- Empty transcription, provider failure, or delivery failure keeps audio for
  Retry or Discard. New dictation does not overwrite a pending take.
- Retry from the recovery card copies the transcript to the clipboard instead
  of inserting into a destination that may have disappeared during restart.
  A persistent card shows the recovered text with Copy, Paste transcript, and
  Dismiss actions. Undo still uses the normal insertion path.
- Retrying from recording history also copies the resulting transcript. If
  clipboard copy fails, the successful text and its Copy action remain visible.
- Unreadable legacy recordings are identified as interrupted, with Discard
  available and no misleading Retry or “safe recording” promise. A filename
  or non-empty file alone does not establish that its audio is readable.
- Compressed audio is filed as pending before transcription starts. History
  writes replace the index atomically; a delayed pending write cannot erase a
  completed outcome. Abandoned CAF files are swept after the retention window.

## Optional Parakeet

Settings → Voice → Transcription has three engines: Apple Speech (default),
Parakeet, and OpenRouter. Selecting Parakeet explicitly downloads NVIDIA
Parakeet TDT 0.6B v3 through FluidAudio, using its corrected linear INT8 (`int8V2`) Core ML encoder and
Apple Neural Engine. It requires Apple Silicon and macOS 14 or later. Model
files are stored under the desktop application data directory in
`parakeet-v3-int8-v2`; they are not shipped inside the app. Setup shows download
and compilation progress and can be retried after a failure. Advanced options
include an explicit Re-download model action for damaged caches. The readiness
check requires the compiled components and vocabulary, not just a marker file.
The linear encoder is about 143 MB larger than the original palettized export
and fixes its documented word-corruption case (FluidAudio #760 / #872). The
cache version changes deliberately so old weights are never silently used or
re-downloaded on app startup.

The helper uses the same CAF capture, M4A export, and delivery workflow.
Recording starts prewarming the installed model; inference loads local files
without network fallback. Optional transcript cleanup and voice rewrite still
use OpenRouter, as they do with Apple Speech. Failed or retained Parakeet
recordings retry locally by default. Explicitly choosing an OpenRouter retry
model sends that retained audio to the chosen cloud provider.

Advanced options set the idle lifetime to 0–60 minutes (15 by default). Zero
unloads after each operation and skips recording-start prewarming. Disabling
dictation or selecting another engine stops the helper after its current
operation. Idle expiry and app shutdown terminate the helper rather than
retaining a runtime with allocator caches. Requests arriving during setup wait for its serialized worker; unexpected
helper exits are reaped and replaced on the next request. Already-loaded
prewarming skips unnecessary helper IPC, and queued prewarming rechecks whether
the provider is still enabled. Starting the app does not download
or load models, and status polling reads cached state without launching ASR.

The sidecar is a Swift executable under `apps/desktop/parakeet-runtime`, pinned
to a FluidAudio revision. `npm run parakeet-runtime:prepare` builds it with
Swift 6.2 or later and stages the target-specific executable for Tauri. Desktop
dev/build hooks and release CI prepare it automatically. ASR does not use the
SDK's TTS resource bundle or optional NeMo text-normalization library. Third
party notices are bundled under `Resources/licenses/parakeet`.

Local M4 Pro smoke test (48 GiB RAM, macOS 26.6.2): after download and model
compilation, three fresh helper processes reached the first transcript of a
7.16-second synthetic clip in 192–336 ms; repeat clips took 51–56 ms. Helper
physical footprint was 37 MiB and RSS 78–79 MiB. Core ML also uses shared
system/Neural Engine resources: these process figures are **not total model
RAM**. The corrected encoder adds about 143 MB to the original 469 MiB cache. This verifies the runtime path and
startup speed, not recognition quality on the user's voice. Experiment scripts
and raw measurements remain outside the repository under
`~/.falcondeck/experiments/parakeet-startup`.

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
editor exposes a non-empty selection. Chromium, Electron, and many web
editors report a successful empty AX selection even when text is highlighted;
those cases fall through to a snapshot-and-restore Command-C. The rewrite
shortcut is lifted for that copy so a held Right Option does not turn it into
Option-Command-C. The spoken instruction is transcribed with the same engine
as dictation, then the selection is rewritten through
OpenRouter (default `openai/gpt-5.6-luna`, with faster options such as
`openai/gpt-oss-120b`) using the existing speech API key. Settings → Voice
has a Custom prompt control that opens pre-filled with the built-in system
prompt; Reset restores that original.
The rewritten text is delivered with the same Command-V paste path as
dictation. Empty selections fail instead of typing the instruction. The model
is told to treat the passage as material to edit, never as a question to
answer, and not to polish it into generic LLM prose.

Vocabulary hints, learned writing-style profiles, and Windows support are
deliberately outside this version. A local
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
7. Record and press Escape; confirm no text is pasted, Undo restores the take
   for ten seconds, and letting that window expire removes the cancelled audio.
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
13a. With text in a TextEdit document, a browser field, and FalconDeck's
    composer (nothing selected), triple-tap Right Option and confirm the whole
    field is tidied and replaced with no recording pill first.

14. Exit during transcription, relaunch, and retry from the recovery card;
    confirm the text is copied, remains visible, and is not inserted into an
    unrelated app. Paste transcript explicitly inserts the recovered text.
15. Interrupt capture or M4A export; confirm retry can read the saved CAF and
    export it again. An older incomplete M4A should offer Discard without Retry.
16. Deny a clipboard write after a successful retry; confirm the transcript
    stays visible with a working Copy action rather than reporting ASR failure.

## History retry model selection

Recording history retries start with the configured preferred cloud model,
not the fallback model that may have produced the bad transcript. Local
Parakeet entries continue to retry locally unless a cloud model is selected.
Cloud history retries send `no_fallback: true` to `/api/speech/transcribe`
(and the equivalent `speech.transcribe` RPC). The daemon uses exactly the
requested model and returns its error or empty-transcription failure rather
than silently substituting another model. Omitted or false `no_fallback`
preserves the automatic fallback chain for ordinary dictation and older clients.

# Native voice composer — 17 October 2026

The native client previously defaulted to Apple's on-device speech recognition.
New recordings now default to `openrouter`, using the existing encrypted
`speech.transcribe` daemon RPC and Expo's `openai/gpt-4o-mini-transcribe` default.
The key stays on the computer. Explicit on-device preferences remain available in
Settings → Speech. Saved audio retains its original provider, including a local
default for older recordings with unknown provenance; cloud errors do not switch
engines automatically.

The reference implementations are Expo's `InlineVoiceRecorder.tsx`,
`VoiceWaveform.tsx`, `openRouterTranscription.ts`, `cloudVoiceRecording.ts` and
client-core's transcript insertion helper. The native recording uses the same
16 kHz mono/32 kbps AAC format and bounded ten-attempt retry/backoff policy.
Configuration is checked before opening the microphone. Permanent credential or
payload errors stop retries; cancel suppresses delayed results and retains audio.

Recording and transcription replace the input and footer. The compact row has
Cancel, a waveform/timer, Stop to edit, and Transcribe and send. Busy state shows
Transcribing or its retry count. Failure offers settings, discard/re-record and
retry. Accessibility text uses the full width for errors above the controls.
Draft text and attachments survive voice input; insertion respects the captured
selection and falls back to append if the draft changed asynchronously. Both
in-app completion and Lock Screen Finish use the same per-chat insertion state.
Voice Send uses the ordinary submit path, including goal commands.

Validation:

- All 117 unit tests pass, including speech regressions for the provider and
  model, request payload, retry bounds, cancellation, preflight, Unicode insertion
  and Lock Screen Finish.
- Focused composer/first-send/keyboard UI checks pass on iPhone and iPad.
  Starting, recording, transcribing and failed states are exercised with local
  Debug demo fixtures. Cancelling every state restores the existing draft.
- All four voice states pass at accessibility-large text size; screenshots were
  inspected. Fixtures do not open a microphone, read audio or send relay requests.
- A signed Apple Development Debug app/widget build and deep signature check pass.
  The updated build is installed on James' iPhone. Real microphone/transcription
  quality still needs a phone check; simulated UI fixtures do not measure speech
  accuracy.

Local results and captures are kept under the ignored
`artifacts/voice-2026-10-17/` directory. Expo, daemon, relay and released app
sources/builds are unchanged by this work.

Repo-local Autoreview used `--mode local --max-priority P2` in an isolated checkout
containing only the native patch. Adjacent recorder/composer/Live Activity owners,
Expo's recorder/settings/retry implementation and the shared insertion helper were
included as datasets. Its Lock Screen selection finding was fixed with a regression;
the final pass is clean, with no actionable P0–P2 findings. Documentation-only
verification updates use `git diff --check` and skip Autoreview.

## Microphone follow-up

The physical-device crash report showed `EXC_BREAKPOINT` in
`String.UTF16View._offsetRange` → `Foundation._NSRange.init` →
`ComposerView.beginVoiceInput`. SwiftUI retained a cursor selection after sending
and clearing the draft; converting those stale indices against the empty draft
trapped before recording began. A simulator test reproduced the failure by
typing a Unicode draft, sending it, and then tapping the microphone.

Selection updates now snapshot their owning text without scanning it on every
keystroke. Starting dictation validates the snapshot's positions before creating
UTF-16 offsets. Changed text falls back to appending, including canonically equal
Unicode strings with different UTF-16 layouts. Clearing/shortening drafts and
valid Unicode selections have regression coverage. The microphone follows the
model/settings controls on the right, beside send/stop, matching Expo's order.

All 117 unit tests and the three focused voice UI tests pass on iPhone/iPad.
These cover the reproduced crash, control order, and all four voice states.
Screenshots were inspected and saved in ignored
`artifacts/microphone-fix-2026-10-17/`. The native-only patch passed
`.agents/skills/autoreview/scripts/autoreview --mode local --max-priority P2`
with composer, voice-control, transcription and chat-session datasets and the
crash stack supplied as context: no actionable P0–P2 findings.

## Reconnect, OpenRouter and read-aloud follow-up

The screenshot's OpenRouter failure was a native-only preflight: the app checked
connection/key readiness before opening the microphone. Expo captures locally
first. Native now does the same, preserving audio when upload is unavailable.
Transcription shows “Waiting for connection…” during a bounded reconnect wait.
A session-scoped audio lifetime survives socket replacement; forgetting, demo
switches and re-pairing still invalidate in-flight work, preventing a late upload
or response from crossing pairing boundaries. Recordings remain retryable.

Read aloud no longer gets stopped by an ordinary relay reconnect. Later-chunk
and decode failures retain the response ID so their error is visible in the
transcript. Pausing/resuming between fetched chunks cannot restart the previous
player, and a chunk arriving while paused stays silent until resumed. Read aloud
rejects attempts to take over an active recording, including the context-menu
path. Audio owners release the shared audio session only when they acquired it.

Composer completion and Lock Screen Finish now share the same insertion owner:
a saved recording is consumed only after its transcript enters the registered
chat. Archiving or replacing that chat while transcription is pending retains
the audio for recovery. Speech settings refresh readiness when reconnection
finishes. Existing explicit voice/transcription provider choices are preserved.

Validation: the original offline microphone, reconnect interruption, hidden
later-chunk error and audio-ownership failures were reproduced with regression
checks. The final suite has 151 passing unit tests. Six focused UI cases passed
on both iPhone and iPad simulators: mic after sending/clearing a Unicode draft,
control order, recorder states, actual local capture while offline, successful
fixture transcription back into the existing draft, and a response-specific TTS
error. Isolated preview storage protects real saved recordings during UI tests.
Screenshots were visually inspected and live under ignored
`artifacts/audio-2026-10-17/index.html`.

A separate temporary probe used the simulator's existing pairing and a generated
20 KB synthetic recording. The real relay/daemon OpenRouter transcription and
TTS requests passed; returned audio decoded and played with AVAudioPlayer, with
pause/resume checks. That complete probe took about nine seconds. The probe and
its audio were removed from the default test target before the final build and
kept only in ignored artifacts. No personal recording or conversation turn was
submitted, and no credentials were copied or logged.

Repo Autoreview (`--mode local --max-priority P2`) found no actionable issues in
the native speech patch or the subsequent insertion-ownership delta. Reviews
used isolated native-only worktrees. The TTS error accessibility identifier and
its assertion are mechanical QA instrumentation. The signed Apple Development
Debug build remains standalone; Expo, daemon, relay, OTA and TestFlight builds
were not changed or deployed.

The final typing-after-dictation check exposed a cursor restoration bug: UIKit
restored the field's previous selection when focus returned, so the next typed
text could land after the first letter. Caret restoration now follows the new
field's focus update, and rebuilds the position only while the draft's exact
UTF-16 contents still match. The iPhone and iPad tests both transcribe into a
nonempty draft and then type more text, verifying it appends at the intended
position. A focused Autoreview of this correction also reported no actionable
P0–P2 findings.

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

- All 113 unit tests pass, including eight new speech tests for the provider and
  model, request payload, retry bounds, cancellation, preflight, Unicode insertion
  and Lock Screen Finish.
- Focused composer/first-send/keyboard UI checks pass on iPhone and iPad.
  Starting, recording, transcribing and failed states are exercised with local
  Debug demo fixtures. Cancelling every state restores the existing draft.
- All four voice states pass at accessibility-large text size; screenshots were
  inspected. Fixtures do not open a microphone, read audio or send relay requests.
- A signed Apple Development Debug app/widget build and deep signature check pass.
  This voice build has not reached the physical phone: installation was refused
  because trusted connectivity/device services were unavailable. The previous
  native build remains installed. Real microphone/transcription quality still
  needs a phone check; simulated UI fixtures do not measure speech accuracy.

Local results and captures are kept under the ignored
`artifacts/voice-2026-10-17/` directory. Expo, daemon, relay and released app
sources/builds are unchanged by this work.

Repo-local Autoreview used `--mode local --max-priority P2` in an isolated checkout
containing only the native patch. Adjacent recorder/composer/Live Activity owners,
Expo's recorder/settings/retry implementation and the shared insertion helper were
included as datasets. Its Lock Screen selection finding was fixed with a regression;
the final pass is clean, with no actionable P0–P2 findings. Documentation-only
verification updates use `git diff --check` and skip Autoreview.

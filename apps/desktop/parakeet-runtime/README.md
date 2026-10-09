# Build the Parakeet helper

Run `npm run parakeet-runtime:prepare` at the repository root. Swift 6.2+ and
Xcode command line tools are required. The script stages a Tauri sidecar for
the host architecture; `--target=x86_64-apple-darwin` builds the Intel release
artifact, although the desktop enables Parakeet only on Apple Silicon.

The pinned Swift package uses FluidAudio's Core ML Parakeet v3 INT8 encoder.
TTS resources and optional NeMo text processing are not required for ASR.
Licenses ship in the application's Resources/licenses/parakeet directory.
See [desktop dictation](../../../docs/18-desktop-dictation.md) for lifecycle,
settings, privacy, and benchmark details.

The sidecar takes one argument: the model-cache root. It accepts one JSON
object per stdin line and writes progress records, then one success or error
record, to stdout. Requests are serialized by the desktop:

- `{"operation":"prepare"}` explicitly downloads, compiles, and loads models.
- `{"operation":"warm"}` loads installed models offline.
- `{"operation":"transcribe","path":"/path/to/clip.m4a"}` returns `text`.
- `{"operation":"shutdown"}` or stdin EOF exits and releases models.

The Rust controller kills the owned process after idle expiry or app shutdown.
Do not use the SDK's download-and-load convenience method during inference:
missing files must produce a settings/setup error instead of network traffic.

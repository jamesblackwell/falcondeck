# Desktop Framework Analysis

Research date: 2026-03-14

## Frameworks Evaluated

### Tauri 2 (Rust + Web Frontend)

- **Used by**: CodexMonitor, Happy (macOS desktop variant)
- **Binary size**: ~10-15MB
- **Memory baseline**: Low (no bundled browser engine)
- **Rendering**: Native OS webview (WebKit on macOS, WebView2 on Windows, WebKitGTK on Linux)
- **Backend language**: Rust
- **Mobile support**: Built-in iOS/Android (Tauri v2)
- **IPC**: Tauri command system (Rust <-> JS)
- **Community**: ~85k GitHub stars, active development
- **License**: MIT

**Subprocess management**: Rust's `tokio::process` for spawning agent processes, `tokio` async runtime for concurrent I/O.

**Relevant Tauri plugins used by CodexMonitor**:
- `tauri-plugin-liquid-glass` (macOS vibrancy)
- `tauri-plugin-notification`
- `tauri-plugin-updater`
- `tauri-plugin-process`

**Trade-offs**:
- Rust learning curve
- WebView rendering may differ across platforms
- Smaller plugin ecosystem than Electron
- No Node.js in renderer (can't use npm packages that depend on Node APIs)
- Tauri 2 mobile support is still maturing

### Electron (Node.js + Chromium)

- **Used by**: Harnss, VS Code, Cursor, Slack, Discord
- **Binary size**: ~150-200MB
- **Memory baseline**: ~300-500MB
- **Rendering**: Bundled Chromium (consistent across platforms)
- **Backend language**: Node.js (TypeScript)
- **Mobile support**: None
- **Community**: Massive ecosystem, battle-tested at scale

**Trade-offs**:
- Large binary and high memory usage
- Full Node.js in main process (trivial subprocess spawning, all npm packages work)
- Consistent rendering across all platforms
- Security surface from bundled Chromium

### Swift / SwiftUI (Native macOS)

- **Used by**: Likely Conductor (macOS-only, native feel)
- **Binary size**: ~5MB
- **Memory baseline**: Lowest
- **Rendering**: Native AppKit/SwiftUI
- **Mobile support**: Code sharing with iOS via Swift/SwiftUI
- **Platform**: macOS only (no Windows, no Linux)

**Trade-offs**:
- Best macOS integration (Liquid Glass, menu bar, gestures, animations)
- No cross-platform (kills Windows/Linux)
- Building rich diff viewers and markdown renderers in SwiftUI is harder
- Smaller developer pool for this type of application

### Wails (Go + Web Frontend)

- **Binary size**: ~10MB
- **Memory baseline**: Low
- **Rendering**: Native OS webview
- **Backend language**: Go
- **Mobile support**: None
- **Community**: Smaller than Tauri

**Trade-offs**:
- Go is more approachable than Rust
- Go excels at concurrency and subprocess management
- Much smaller community and plugin ecosystem
- No mobile support
- Go's GC can cause occasional pauses

### Flutter (Dart)

- **Binary size**: ~15-20MB
- **Memory baseline**: Medium
- **Rendering**: Custom Skia/Impeller engine (not OS webview)
- **Mobile support**: iOS, Android, Web, macOS, Windows, Linux
- **Community**: Large but Dart is niche

**Trade-offs**:
- True cross-platform including mobile from single codebase
- Dart has limited open-source contributor pool
- Desktop support still maturing
- Not ideal for text-heavy UIs (code, diffs)
- Custom rendering engine (doesn't match OS native look)

## Framework Comparison

| Criterion | Tauri 2 | Electron | Swift | Wails | Flutter |
|---|---|---|---|---|---|
| Binary size | ~10MB | ~150MB | ~5MB | ~10MB | ~15MB |
| Memory usage | Low | High | Lowest | Low | Medium |
| Cross-platform | macOS, Win, Linux | macOS, Win, Linux | macOS only | macOS, Win, Linux | All |
| Mobile built-in | iOS, Android (v2) | No | iOS (shared Swift) | No | iOS, Android |
| Agent subprocess | Rust tokio | Node.js child_process | Foundation Process | Go os/exec | Dart Process |
| Ecosystem size | Growing | Massive | Apple-native | Small | Large (but Dart) |
| Claude SDK compat | Needs Node sidecar | Direct (Node.js) | Needs bridge | Needs bridge | Needs bridge |
| Codex app-server | Direct (Rust JSON-RPC) | Direct (Node.js) | Direct (Foundation) | Direct (Go) | Needs bridge |

## Claude Agent SDK Compatibility Note

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) is Node.js only. For non-Node frameworks:

1. **Sidecar process**: Spawn a lightweight Node.js process that uses the SDK, communicate via IPC (JSON over stdio or local socket). This is the most common pattern.
2. **CLI subprocess**: Spawn `claude` CLI directly and parse output. Less structured but no Node.js dependency.
3. **Future Rust/native SDK**: Does not exist yet as of 2026-03-14.

Codex's `app-server` protocol (JSON-RPC over stdio) is language-agnostic and works natively with any language that can spawn processes and read/write stdio.

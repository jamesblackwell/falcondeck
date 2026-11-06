// Hosts apps/desktop/stream-qa.html in the system WKWebView (the engine Tauri
// uses on macOS) and turns the page's wheel requests into real trackpad-shaped
// NSEvents, delivered straight to the web view so no global input is posted.
//
//   swiftc -O webkit-host.swift -o webkit-host
//   webkit-host <url> <output.json>
import AppKit
import WebKit

let arguments = CommandLine.arguments
guard arguments.count >= 3, let url = URL(string: arguments[1]) else {
  FileHandle.standardError.write(Data("usage: webkit-host <url> <output.json>\n".utf8))
  exit(2)
}
let outputPath = arguments[2]

final class Host: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
  var webView: WKWebView!
  var window: NSWindow!

  func phaseValue(_ name: String) -> Int64 {
    switch name {
    case "began": return 1
    case "changed": return 2
    case "ended": return 4
    default: return 0
    }
  }

  func momentumValue(_ name: String) -> Int64 {
    switch name {
    case "began": return 1
    case "changed": return 2
    case "ended": return 3
    default: return 0
    }
  }

  func wheel(deltaY: Double, phase: String, momentum: String) {
    // A window-less NSEvent reports its screen point as locationInWindow, and
    // WebKit reads that as a window coordinate. Aim at the view's centre as if
    // the window sat at the origin, so the hit test holds wherever it really is.
    let primaryHeight = NSScreen.screens.first?.frame.height ?? 0
    let point = CGPoint(x: webView.bounds.midX, y: primaryHeight - webView.bounds.midY)
    // CGEvent wheel values follow the natural direction: positive reveals
    // content above, which is a negative DOM deltaY.
    let pixels = Int32((-deltaY).rounded())
    guard let event = CGEvent(
      scrollWheelEvent2Source: nil,
      units: .pixel,
      wheelCount: 1,
      wheel1: pixels,
      wheel2: 0,
      wheel3: 0
    ) else { return }
    event.location = point
    event.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    event.setIntegerValueField(.scrollWheelEventScrollPhase, value: phaseValue(phase))
    event.setIntegerValueField(.scrollWheelEventMomentumPhase, value: momentumValue(momentum))
    guard let nsEvent = NSEvent(cgEvent: event) else { return }
    webView.scrollWheel(with: nsEvent)
  }

  func userContentController(
    _ controller: WKUserContentController,
    didReceive message: WKScriptMessage
  ) {
    guard let body = message.body as? [String: Any], let cmd = body["cmd"] as? String else {
      return
    }
    switch cmd {
    case "wheel":
      wheel(
        deltaY: (body["deltaY"] as? NSNumber)?.doubleValue ?? 0,
        phase: body["phase"] as? String ?? "none",
        momentum: body["momentum"] as? String ?? "none"
      )
    case "done":
      let result = body["result"] as? String ?? "{}"
      try? result.write(toFile: outputPath, atomically: true, encoding: .utf8)
      exit(0)
    case "error":
      FileHandle.standardError.write(Data("page error: \(body["message"] ?? "")\n".utf8))
      exit(1)
    default:
      break
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let host = Host()
let configuration = WKWebViewConfiguration()
configuration.userContentController.add(host, name: "qa")
// Far off every display and never activated, so a run cannot cover or take
// focus from anything on screen. Occlusion detection is off so WebKit keeps
// producing frames there; the page's recording shows the real frame rate.
let frame = NSRect(x: -6000, y: -6000, width: 1040, height: 800)
let webView = WKWebView(frame: NSRect(origin: .zero, size: frame.size), configuration: configuration)
webView.navigationDelegate = host
let occlusionSetter = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
if webView.responds(to: occlusionSetter) {
  // The setter takes a scalar BOOL, which perform(_:with:) cannot pass.
  typealias Setter = @convention(c) (AnyObject, Selector, Bool) -> Void
  let setter = unsafeBitCast(webView.method(for: occlusionSetter), to: Setter.self)
  setter(webView, occlusionSetter, false)
}
let window = NSWindow(
  contentRect: frame,
  styleMask: [.borderless],
  backing: .buffered,
  defer: false
)
window.contentView = webView
window.level = .normal
window.alphaValue = 0
window.ignoresMouseEvents = true
window.orderBack(nil)
host.webView = webView
host.window = window
// Report what the window server actually holds, so a run proves it was hidden.
DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
  let windows =
    CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
  for info in windows where (info[kCGWindowOwnerPID as String] as? Int32) == getpid() {
    let line =
      "window-audit alpha=\(info[kCGWindowAlpha as String] ?? "?") "
      + "onscreen=\(info[kCGWindowIsOnscreen as String] ?? false) "
      + "bounds=\(info[kCGWindowBounds as String] ?? "?")\n"
    FileHandle.standardError.write(Data(line.utf8))
  }
}
webView.load(URLRequest(url: url))
DispatchQueue.main.asyncAfter(deadline: .now() + 180) {
  FileHandle.standardError.write(Data("timed out\n".utf8))
  exit(3)
}
app.run()

import Darwin
import SwiftUI

// Built-in MCP connectors execute current_exe(). Dispatch before constructing
// the SwiftUI app or its stores, so an agent never recursively opens windows.
if let exitCode = NativeRuntime.dispatchHelperIfNeeded() {
    exit(exitCode)
}

FalconDeckMacApp.main()

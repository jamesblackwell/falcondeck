// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "FalconDeckMac",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "FalconDeckMac", targets: ["FalconDeckMac"])
    ],
    dependencies: [
        .package(url: "https://github.com/jedisct1/swift-sodium.git", from: "0.11.0"),
        .package(url: "https://github.com/migueldeicaza/SwiftTerm.git", exact: "1.99.0"),
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.7.0")
    ],
    targets: [
        .executableTarget(
            name: "FalconDeckMac",
            dependencies: [
                "NativeSpeechBridge",
                .product(name: "Sodium", package: "swift-sodium"),
                .product(name: "SwiftTerm", package: "SwiftTerm"),
                .product(name: "Sparkle", package: "Sparkle")
            ],
            path: "Sources/FalconDeckMac",
            exclude: ["Workspaces/ExtensionHost"],
            resources: [.copy("Workspaces/ExtensionResources"), .copy("Settings/Sounds"), .copy("Design/PaletteCatalog.json")]
        ),
        .target(name: "NativeSpeechBridge", path: "Sources/NativeSpeechBridge",
                publicHeadersPath: "include", cSettings: [.unsafeFlags(["-fobjc-arc"])],
                linkerSettings: ["AppKit", "ApplicationServices", "AVFoundation", "Carbon", "IOKit", "Speech"].map { .linkedFramework($0) }),
        .testTarget(
            name: "FalconDeckMacTests",
            dependencies: ["FalconDeckMac"],
            path: "Tests/FalconDeckMacTests"
        )
    ],
    swiftLanguageModes: [.v5]
)

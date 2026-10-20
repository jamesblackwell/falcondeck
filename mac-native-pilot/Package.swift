// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "FalconDeckMac",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "FalconDeckMac", targets: ["FalconDeckMac"])
    ],
    targets: [
        .executableTarget(
            name: "FalconDeckMac",
            path: "Sources/FalconDeckMac"
        ),
        .testTarget(
            name: "FalconDeckMacTests",
            dependencies: ["FalconDeckMac"],
            path: "Tests/FalconDeckMacTests"
        )
    ],
    swiftLanguageModes: [.v5]
)

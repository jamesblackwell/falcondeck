// swift-tools-version: 6.2
import PackageDescription

let package = Package(
    name: "FalconDeckParakeet",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "falcondeck-parakeet", targets: ["FalconDeckParakeet"])],
    dependencies: [
        .package(
            url: "https://github.com/FluidInference/FluidAudio.git",
            revision: "0b0fa2ad710843d3f40af885caf9a86d1fa49c26",
            traits: []
        )
    ],
    targets: [.executableTarget(
        name: "FalconDeckParakeet",
        dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]
    )]
)

// swift-tools-version:6.0
import PackageDescription

let package = Package(
    name: "pa",
    platforms: [.macOS("26.0")],
    targets: [
        // Pure logic (arg parsing, tap target selection, levels): unit-tested.
        .target(name: "PACore"),
        // Thin OS wrappers (Core Audio, AVFoundation): verified live on the Mac.
        .executableTarget(name: "pa", dependencies: ["PACore"]),
        .testTarget(name: "PACoreTests", dependencies: ["PACore"]),
    ]
)

// swift-tools-version:6.0
import PackageDescription

var dependencies: [Package.Dependency] = []
var targets: [Target] = [
    // Pure logic (arg parsing, levels, wire types, transcript merge): unit-tested, Linux-portable.
    .target(name: "PACore"),
    .testTarget(name: "PACoreTests", dependencies: ["PACore"]),
]

// `pa` + FluidAudio (Core Audio, CoreML) are Apple-only; guarded so osx/test-linux.sh resolves/tests PACore alone.
#if os(macOS)
// upToNextMinor: FluidAudio is 0.x and breaks API between minors.
dependencies.append(.package(url: "https://github.com/FluidInference/FluidAudio", .upToNextMinor(from: "0.17.4")))
// Thin OS wrappers (Core Audio, AVFoundation, FluidAudio): verified live on the Mac.
targets.append(.executableTarget(
    name: "pa",
    dependencies: ["PACore", .product(name: "FluidAudio", package: "FluidAudio")]))
#endif

let package = Package(
    name: "pa",
    platforms: [.macOS("26.0")],
    dependencies: dependencies,
    targets: targets
)

// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "MongjinCore",
    platforms: [
        .iOS(.v17),
        .macOS(.v14),
    ],
    products: [
        .library(name: "MongjinCore", targets: ["MongjinCore"]),
        .executable(name: "mongjin-seed", targets: ["MongjinSeed"]),
    ],
    targets: [
        .target(name: "MongjinCore", path: "Sources/MongjinCore"),
        .executableTarget(
            name: "MongjinSeed",
            dependencies: ["MongjinCore"],
            path: "Sources/MongjinSeed"
        ),
        .testTarget(
            name: "MongjinCoreTests",
            dependencies: ["MongjinCore"],
            path: "Tests/MongjinCoreTests"
        ),
    ]
)

import SwiftUI

enum Palette {
    static let canvas = Color(red: 0.945, green: 0.933, blue: 0.910)
    static let panel = Color(red: 0.984, green: 0.980, blue: 0.969)
    static let surface = Color.white
    static let ink = Color(red: 0.125, green: 0.165, blue: 0.200)
    static let inkSoft = Color(red: 0.392, green: 0.455, blue: 0.502)
    static let blue = Color(red: 0.192, green: 0.373, blue: 0.537)
    static let blueStrong = Color(red: 0.157, green: 0.310, blue: 0.451)
    static let line = Color(red: 0.847, green: 0.831, blue: 0.800)
    static let wood = Color(red: 0.843, green: 0.773, blue: 0.659)
    static let woodEdge = Color(red: 0.710, green: 0.635, blue: 0.518)
    static let ghost = Color(red: 0.45, green: 0.62, blue: 0.78)
    static let capture = Color(red: 1.0, green: 0.42, blue: 0.39)
}

enum Typeface {
    static func display(_ size: CGFloat) -> Font {
        .system(size: size, weight: .bold, design: .serif)
    }

    static func title(_ size: CGFloat) -> Font {
        .system(size: size, weight: .semibold, design: .rounded)
    }

    static func body(_ size: CGFloat) -> Font {
        .system(size: size, weight: .medium, design: .rounded)
    }
}

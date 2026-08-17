import SwiftUI

struct PieceImage: View {
    var player: Player
    var type: PieceType
    var ghostly = false

    var body: some View {
        Image(assetName)
            .resizable()
            .scaledToFit()
            .opacity(ghostly ? 0.72 : 1)
            .shadow(color: ghostly ? Palette.ghost.opacity(0.55) : .black.opacity(0.28), radius: ghostly ? 6 : 2, y: 1)
    }

    private var assetName: String {
        switch (player, type) {
        case (.black, .king): return "stone-black-king"
        case (.black, .escort): return "stone-black-guard"
        case (.white, .king): return "stone-white-king"
        case (.white, .escort): return "stone-white-guard"
        }
    }
}

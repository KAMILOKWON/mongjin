import SwiftUI

struct GuardTray: View {
    var player: Player
    var count: Int
    var active: Bool

    private var isWhite: Bool { player == .white }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 6) {
                Text("\(player.korean) 호위")
                    .font(.system(size: 11, weight: .heavy))
                    .tracking(-0.2)
                Spacer(minLength: 0)
                Text("\(count) / 8")
                    .font(.system(size: 11, weight: .bold).monospacedDigit())
                    .opacity(0.72)
            }
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(minimum: 0), spacing: 5), count: 4),
                spacing: 5
            ) {
                ForEach(0..<8, id: \.self) { index in
                    Color.clear
                        .aspectRatio(1, contentMode: .fit)
                        .overlay {
                            if index < count {
                                PieceImage(player: player, type: .escort)
                            }
                        }
                }
            }
            .padding(.top, 7)
        }
        .padding(.horizontal, 10)
        .padding(.top, 9)
        .padding(.bottom, 10)
        .foregroundStyle(isWhite ? Palette.ink : Color.white)
        .background(trayFill, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(active ? Palette.blue : trayStroke, lineWidth: 1)
        )
        .shadow(color: Palette.ink.opacity(active ? 0.12 : 0.08), radius: active ? 8 : 7, y: 5)
        .overlay {
            if active {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(Palette.blue, lineWidth: 2)
                    .padding(-2)
            }
        }
    }

    private var trayFill: Color {
        isWhite
            ? Color(red: 241 / 255, green: 238 / 255, blue: 230 / 255)
            : Color(red: 48 / 255, green: 58 / 255, blue: 69 / 255)
    }

    private var trayStroke: Color {
        isWhite
            ? Color(red: 222 / 255, green: 217 / 255, blue: 207 / 255)
            : Color(red: 48 / 255, green: 58 / 255, blue: 69 / 255)
    }
}

import SwiftUI

struct BoardView: View {
    var session: GameSession
    var ghostSide: Player?
    var showsCoordinates = true

    var body: some View {
        GeometryReader { geo in
            let cell = min(geo.size.width, geo.size.height) / 9
            let files = Array("abcdefghi")
            ZStack {
                Image("board-light-ash")
                    .resizable()
                    .scaledToFill()
                    .opacity(0.55)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Palette.wood.opacity(0.55))
                VStack(spacing: 0) {
                    ForEach(0..<9, id: \.self) { r in
                        HStack(spacing: 0) {
                            ForEach(0..<9, id: \.self) { c in
                                let coord = Coord(r: r, c: c)
                                cellView(
                                    coord: coord,
                                    size: cell,
                                    file: files[c],
                                    showFile: showsCoordinates && r == 8,
                                    showRank: showsCoordinates && c == 0
                                )
                            }
                        }
                    }
                }
                .padding(7)
            }
            .frame(width: cell * 9 + 14, height: cell * 9 + 14)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .stroke(Palette.woodEdge, lineWidth: 1.2)
            )
            .position(x: geo.size.width / 2, y: geo.size.height / 2)
        }
        .aspectRatio(1, contentMode: .fit)
    }

    @ViewBuilder
    private func cellView(coord: Coord, size: CGFloat, file: Character, showFile: Bool, showRank: Bool) -> some View {
        let mark = session.highlights(for: coord)
        let piece = session.state.piece(at: coord)
        let guiding = session.isTutorial && !session.tutorialFinished
        let dimmed = guiding && piece != nil && !mark.isHint && !mark.isSelected
        Button {
            session.tap(coord)
        } label: {
            ZStack {
                Rectangle()
                    .fill(cellFill(mark))
                    .overlay(Rectangle().stroke(Palette.woodEdge.opacity(0.45), lineWidth: 0.55))
                if mark.isHint {
                    TutorialHintWash(emphasized: mark.isPlace || (mark.isTarget && session.selected != nil))
                }
                if mark.isLastMove {
                    Rectangle()
                        .stroke(Palette.blue, lineWidth: 2)
                        .padding(1)
                }
                if mark.isSelected {
                    Rectangle()
                        .stroke(Palette.blueStrong, lineWidth: 3)
                        .padding(1)
                }
                if mark.isCapture {
                    RoundedRectangle(cornerRadius: 4)
                        .stroke(Palette.capture, lineWidth: 2.4)
                        .padding(3)
                }
                if mark.isTarget && !mark.isCapture && !mark.isHint {
                    Circle()
                        .fill(Palette.ink.opacity(0.45))
                        .frame(width: size * 0.22, height: size * 0.22)
                }
                if mark.isPlace && !mark.isHint {
                    Circle()
                        .stroke(Palette.ink.opacity(0.55), lineWidth: 2)
                        .frame(width: size * 0.2, height: size * 0.2)
                }
                if let piece {
                    PieceImage(
                        player: piece.player,
                        type: piece.type,
                        ghostly: ghostSide == piece.player && session.thinking
                    )
                    .padding(size * 0.05)
                    .scaleEffect(mark.isSelected ? 1.06 : 1)
                    .opacity(dimmed ? 0.38 : 1)
                }
                if mark.isHint, piece != nil, session.selected == nil {
                    Image(systemName: "hand.tap.fill")
                        .font(.system(size: max(11, size * 0.22), weight: .bold))
                        .foregroundStyle(.white)
                        .padding(5)
                        .background(Palette.blue, in: Circle())
                        .overlay(Circle().stroke(.white.opacity(0.9), lineWidth: 1.2))
                        .offset(x: size * 0.30, y: -size * 0.30)
                        .allowsHitTesting(false)
                }
                if showRank {
                    Text("\(9 - coord.r)")
                        .font(.system(size: 8, weight: .bold, design: .serif))
                        .foregroundStyle(Palette.ink.opacity(0.45))
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .padding(3)
                }
                if showFile {
                    Text(String(file))
                        .font(.system(size: 8, weight: .bold, design: .serif))
                        .foregroundStyle(Palette.ink.opacity(0.45))
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                        .padding(3)
                }
            }
            .frame(width: size, height: size)
        }
        .buttonStyle(.plain)
    }

    private func cellFill(_ mark: CellHighlight) -> Color {
        if mark.isHint { return Palette.blue.opacity(0.16) }
        if mark.isGoalBlack { return Palette.blue.opacity(0.12) }
        if mark.isGoalWhite { return Color.white.opacity(0.38) }
        return Palette.panel.opacity(0.28)
    }
}

private struct TutorialHintWash: View {
    var emphasized = false
    @State private var lit = false

    var body: some View {
        Rectangle()
            .fill(Palette.blue.opacity(lit ? (emphasized ? 0.50 : 0.34) : (emphasized ? 0.24 : 0.16)))
            .overlay(Rectangle().stroke(Palette.blue, lineWidth: emphasized ? 3 : 2.4))
            .onAppear {
                withAnimation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true)) {
                    lit = true
                }
            }
    }
}

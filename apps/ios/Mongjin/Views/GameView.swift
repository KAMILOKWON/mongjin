import SwiftUI

struct GameView: View {
    @Environment(AppModel.self) private var model
    @State private var showResult = false
    @State private var confirmResign = false

    var body: some View {
        if let session = model.session {
            ZStack {
            VStack(spacing: 0) {
                ScreenNav(title: session.isQuickMatch ? "빠른 대전" : session.mode.title, onBack: { handleBack(session) }) {
                    if session.canResign {
                        Menu {
                            Button("항복", role: .destructive) {
                                confirmResign = true
                            }
                        } label: {
                            Image(systemName: "ellipsis")
                                .font(.system(size: 17, weight: .semibold))
                                .foregroundStyle(Palette.ink)
                                .frame(width: 44, height: 44)
                        }
                    }
                }

                if case .ghost(let tape) = session.mode {
                    MatchSeats(tape: tape, session: session, me: model.profile)
                        .padding(.horizontal, 16)
                        .padding(.bottom, 8)
                }

                BoardView(session: session, ghostSide: ghostSide(session))
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)

                VStack(spacing: 10) {
                    if let result = session.result {
                        Text(resultLabel(result, session: session))
                            .font(Typeface.title(16))
                            .foregroundStyle(Palette.blueStrong)
                    } else {
                        HStack(spacing: 8) {
                            Circle()
                                .fill(session.state.turn == .black ? Palette.ink : Color.white)
                                .overlay(Circle().stroke(Palette.line, lineWidth: 1))
                                .frame(width: 12, height: 12)
                            Text(session.turnLabel)
                                .font(Typeface.title(16))
                            if session.thinking {
                                ProgressView()
                                    .controlSize(.small)
                            }
                        }
                    }

                    HStack(spacing: 10) {
                        GuardTray(
                            player: .white,
                            count: session.state.guardsInHand[.white] ?? 0,
                            active: session.result == nil && session.state.turn == .white
                        )
                        GuardTray(
                            player: .black,
                            count: session.state.guardsInHand[.black] ?? 0,
                            active: session.result == nil && session.state.turn == .black
                        )
                    }
                }
                .padding(.horizontal, 16)

                HStack(spacing: 10) {
                    if session.isQuickMatch {
                        MoveClock(deadline: session.moveDeadline)
                    } else {
                        Button("무르기") { session.undo() }
                            .buttonStyle(SecondaryButtonStyle())
                            .disabled(!session.canUndo)
                            .opacity(session.canUndo ? 1 : 0.45)
                    }
                    Button(session.result == nil ? (session.isQuickMatch ? "항복" : "대국 종료") : "나가기") {
                        if session.canResign {
                            confirmResign = true
                        } else {
                            model.leaveGame()
                        }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                }
                .padding(16)
            }
            .background(Palette.panel.ignoresSafeArea())

            if showResult, let result = session.result {
                Palette.ink.opacity(0.38)
                    .ignoresSafeArea()
                ResultCard(result: result, session: session) {
                    showResult = false
                    model.leaveGame()
                }
                .padding(.horizontal, 32)
                .transition(.scale(scale: 0.96).combined(with: .opacity))
            }
            }
            .animation(.easeOut(duration: 0.2), value: showResult)
            .onChange(of: session.result != nil) { _, finished in
                if finished { showResult = true }
            }
            .confirmationDialog("항복할까요?", isPresented: $confirmResign, titleVisibility: .visible) {
                Button("항복", role: .destructive) {
                    session.resign()
                }
                Button("취소", role: .cancel) {}
            } message: {
                Text("이 대국은 패배로 기록됩니다. 상대 입장에서는 당신이 항복한 것으로 남습니다.")
            }
        }
    }

    private func handleBack(_ session: GameSession) {
        if session.canResign {
            confirmResign = true
        } else {
            model.leaveGame()
        }
    }

    private func ghostSide(_ session: GameSession) -> Player? {
        if case .ghost(let tape) = session.mode { return tape.side }
        return nil
    }

    private func resultLabel(_ result: GameResult, session: GameSession) -> String {
        if case .ghost = session.mode {
            if result.reason == .forfeit {
                return result.winner == session.humanSide ? "승리 · 상대가 항복함" : "패배 · 항복"
            }
            if result.reason == .timeout {
                return result.winner == session.humanSide ? "승리 · 상대가 시간 초과" : "패배 · 시간 초과"
            }
            return result.winner == session.humanSide
                ? "승리 · \(result.reason.korean)"
                : "패배 · \(result.reason.korean)"
        }
        return result.label
    }
}

struct MatchSeats: View {
    var tape: GhostTape
    var session: GameSession
    var me: PlayerCard

    var body: some View {
        HStack(spacing: 10) {
            seat(color: .white)
            seat(color: .black)
        }
    }

    private func seat(color: Player) -> some View {
        let mine = session.humanSide == color
        let name = mine ? me.name : tape.ownerName
        let rating = mine ? me.rating : tape.ownerRating
        let active = session.result == nil && session.state.turn == color
        let isWhite = color == .white

        return HStack(spacing: 8) {
            PieceImage(player: color, type: .escort)
                .frame(width: 30, height: 30)

            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(name)
                        .font(.system(size: 14, weight: .semibold))
                        .lineLimit(1)
                    if mine {
                        Text("나")
                            .font(.system(size: 10, weight: .heavy))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(isWhite ? Palette.blue.opacity(0.14) : Color.white.opacity(0.16), in: Capsule())
                    }
                }
                Text("\(color.korean) · Elo \(rating)")
                    .font(.system(size: 11, weight: .medium))
                    .opacity(0.72)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 9)
        .foregroundStyle(isWhite ? Palette.ink : Color.white)
        .background(
            isWhite
                ? Color(red: 241 / 255, green: 238 / 255, blue: 230 / 255)
                : Color(red: 48 / 255, green: 58 / 255, blue: 69 / 255),
            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(active ? Palette.blue : (isWhite ? Color(red: 222 / 255, green: 217 / 255, blue: 207 / 255) : Color(red: 48 / 255, green: 58 / 255, blue: 69 / 255)), lineWidth: 1)
        )
        .overlay {
            if active {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(Palette.blue, lineWidth: 2)
                    .padding(-2)
            }
        }
        .frame(maxWidth: .infinity)
    }
}

struct MoveClock: View {
    var deadline: Date?

    var body: some View {
        TimelineView(.periodic(from: .now, by: 0.2)) { context in
            let remaining = max(0, deadline?.timeIntervalSince(context.date) ?? 0)
            let running = deadline != nil
            let urgent = running && remaining <= 10
            VStack(spacing: 2) {
                Text(running ? Self.format(remaining) : "—:—")
                    .font(.system(size: 20, weight: .heavy, design: .rounded).monospacedDigit())
                    .foregroundStyle(urgent ? Palette.capture : Palette.ink)
                Text(running ? "남은 시간" : "상대 차례")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(urgent ? Palette.capture : Palette.inkSoft)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .background(
                Palette.surface.opacity(1),
                in: RoundedRectangle(cornerRadius: 16, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .stroke(urgent ? Palette.capture.opacity(0.55) : Palette.line, lineWidth: 1)
            )
            .accessibilityLabel(running ? "남은 시간 \(Self.format(remaining))" : "상대 차례")
        }
    }

    private static func format(_ seconds: TimeInterval) -> String {
        let whole = Int(seconds.rounded(.down))
        return String(format: "%d:%02d", whole / 60, whole % 60)
    }
}

struct ScreenNav<Trailing: View>: View {
    var title: String
    var onBack: () -> Void
    @ViewBuilder var trailing: () -> Trailing

    init(title: String, onBack: @escaping () -> Void, @ViewBuilder trailing: @escaping () -> Trailing) {
        self.title = title
        self.onBack = onBack
        self.trailing = trailing
    }

    var body: some View {
        ZStack {
            Text(title)
                .font(.system(size: 16, weight: .heavy))
                .tracking(-0.4)
                .lineLimit(1)
                .padding(.horizontal, 52)
            HStack(spacing: 0) {
                Button(action: onBack) {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundStyle(Palette.ink)
                        .frame(width: 44, height: 44)
                }
                Spacer(minLength: 0)
                trailing()
                    .frame(width: 44, height: 44)
            }
        }
        .frame(height: 58)
        .padding(.horizontal, 10)
        .fixedSize(horizontal: false, vertical: true)
    }
}

extension ScreenNav where Trailing == EmptyView {
    init(title: String, onBack: @escaping () -> Void) {
        self.init(title: title, onBack: onBack) {
            EmptyView()
        }
    }
}

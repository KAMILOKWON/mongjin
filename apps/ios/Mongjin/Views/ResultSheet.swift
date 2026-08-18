import SwiftUI

struct ResultCard: View {
    var result: GameResult
    var session: GameSession
    var onConfirm: () -> Void

    var body: some View {
        VStack(spacing: 12) {
            Text(heading)
                .font(.system(size: 22, weight: .heavy))
                .tracking(-0.5)
                .foregroundStyle(Palette.ink)
                .multilineTextAlignment(.center)

            Text(reasonCopy)
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Palette.inkSoft)
                .multilineTextAlignment(.center)

            Button("확인", action: onConfirm)
                .buttonStyle(PrimaryButtonStyle())
                .padding(.top, 6)
        }
        .padding(.horizontal, 22)
        .padding(.top, 26)
        .padding(.bottom, 20)
        .frame(maxWidth: 340)
        .background(Palette.panel, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
        .shadow(color: Palette.ink.opacity(0.16), radius: 24, y: 10)
    }

    private var isQuick: Bool {
        session.isQuickMatch
    }

    private var won: Bool {
        if isQuick { return result.winner == session.humanSide }
        return false
    }

    private var heading: String {
        if isQuick {
            return won ? "이겼습니다" : "패배했습니다"
        }
        return "\(result.winner.korean) 승리"
    }

    private var reasonCopy: String {
        switch result.reason {
        case .forfeit:
            return won ? "상대가 항복했습니다" : "항복했습니다"
        case .timeout:
            return won ? "상대가 시간 안에 두지 못했습니다" : "1분 안에 두지 못했습니다"
        case .goal:
            if isQuick {
                return won ? "왕이 목적지에 도착했습니다" : "상대 왕이 목적지에 도착했습니다"
            }
            return "왕이 목적지에 도착했습니다"
        case .capture:
            return isQuick
                ? (won ? "상대 왕을 잡았습니다" : "왕이 잡혔습니다")
                : "왕을 잡아 이겼습니다"
        case .surround:
            return isQuick
                ? (won ? "상대 왕을 포위했습니다" : "왕이 포위되었습니다")
                : "왕을 포위해 이겼습니다"
        case .noMoves:
            return isQuick
                ? (won ? "상대가 둘 수 없었습니다" : "둘 수 있는 수가 없었습니다")
                : "둘 수 있는 수가 없었습니다"
        }
    }
}

struct GhostFile: Transferable {
    var tape: GhostTape

    static var transferRepresentation: some TransferRepresentation {
        DataRepresentation(exportedContentType: .json) { file in
            try GhostCodec.encode(file.tape)
        }
        .suggestedFileName("mongjin-ghost.json")
    }
}

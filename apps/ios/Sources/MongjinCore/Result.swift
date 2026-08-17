import Foundation

public enum WinReason: String, Codable, Sendable {
    case goal
    case capture
    case surround
    case noMoves = "no-moves"
    case forfeit
    case timeout

    public var korean: String {
        switch self {
        case .goal: return "왕이 목적지에 도달"
        case .capture: return "상대 왕을 잡음"
        case .surround: return "상대 왕을 포위"
        case .noMoves: return "상대가 둘 수 없음"
        case .forfeit: return "상대가 항복함"
        case .timeout: return "상대가 시간 초과"
        }
    }
}

public struct GameResult: Hashable, Codable, Sendable {
    public var winner: Player
    public var reason: WinReason

    public init(winner: Player, reason: WinReason) {
        self.winner = winner
        self.reason = reason
    }

    public var label: String {
        "\(winner.korean) 승리 · \(reason.korean)"
    }
}

public func getResult(_ state: GameState, _ config: RuleConfig) -> GameResult? {
    let n = state.size

    for player in Player.allCases {
        if findKing(in: state, player: player) == nil {
            return GameResult(winner: player.opponent, reason: .capture)
        }
    }

    for player in Player.allCases {
        if let king = findKing(in: state, player: player),
           isGoalCell(player: player, coord: king, config: config) {
            return GameResult(winner: player, reason: .goal)
        }
    }

    if config.kingSurroundLoss {
        for player in Player.allCases {
            guard let king = findKing(in: state, player: player) else { continue }
            let surrounded = ortho.allSatisfy { dr, dc in
                let r = king.r + dr
                let c = king.c + dc
                if !inBoard(n, r, c) { return true }
                if let piece = state.board[r][c] {
                    return piece.player != player
                }
                return false
            }
            if surrounded {
                return GameResult(winner: player.opponent, reason: .surround)
            }
        }
    }

    if legalMoves(state, config).isEmpty {
        return GameResult(winner: state.turn.opponent, reason: .noMoves)
    }

    return nil
}

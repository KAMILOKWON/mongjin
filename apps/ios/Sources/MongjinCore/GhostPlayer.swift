import Foundation

public enum GhostStyle: String, Codable, Sendable {
    /// 저장된 기보 수를 그대로 두었다.
    case recorded
    /// 기보 수가 불가라 가까운 합법 수로 바꿨다.
    case adapted
    /// 기보가 끝났거나 응용할 수가 없어 AI가 즉흥으로 두었다.
    case improvised

    public var korean: String {
        switch self {
        case .recorded: return "기보대로"
        case .adapted: return "기보를 응용"
        case .improvised: return "즉흥 응수"
        }
    }
}

public struct GhostDecision: Sendable {
    public var move: Move
    public var style: GhostStyle
    public var note: String
}

/// 저장된 기보를 재생한다. 도전자가 다른 수를 두면 가까운 합법 수·AI로 적응한다.
public struct GhostController: Sendable {
    public var tape: GhostTape
    public private(set) var ply: Int
    public private(set) var recordedCount: Int
    public private(set) var adaptedCount: Int
    public private(set) var improvisedCount: Int

    public init(tape: GhostTape) {
        self.tape = tape
        self.ply = 0
        self.recordedCount = 0
        self.adaptedCount = 0
        self.improvisedCount = 0
    }

    public var fidelity: Double {
        let total = recordedCount + adaptedCount + improvisedCount
        guard total > 0 else { return 1 }
        return Double(recordedCount) / Double(total)
    }

    public mutating func choose(state: GameState, config: RuleConfig) -> GhostDecision? {
        let legal = legalMoves(state, config)
        guard !legal.isEmpty else { return nil }

        if ply < tape.moves.count {
            let recorded = tape.moves[ply]
            ply += 1
            if legal.contains(recorded) {
                recordedCount += 1
                return GhostDecision(move: recorded, style: .recorded, note: "기보 \(ply)수")
            }
            if let similar = adapt(recorded, legal: legal, state: state) {
                adaptedCount += 1
                return GhostDecision(
                    move: similar,
                    style: .adapted,
                    note: "기보 \(ply)수가 불가라 가까운 수로 응수"
                )
            }
        }

        let options = AiOptions.ghostFallback
        guard let move = chooseMove(state, config, options: options) ?? legal.first else { return nil }
        improvisedCount += 1
        let note = ply > tape.moves.count
            ? "기보가 끝나 즉흥으로 둡니다"
            : "기보를 따라갈 수 없어 즉흥으로 둡니다"
        return GhostDecision(move: move, style: .improvised, note: note)
    }

    private func adapt(_ recorded: Move, legal: [Move], state: GameState) -> Move? {
        switch recorded {
        case .place(let to):
            let places = legal.filter(\.isPlace)
            return places.min { a, b in
                a.to.manhattan(to: to) < b.to.manhattan(to: to)
            }
        case .move(let from, let to):
            let moves = legal.filter { !$0.isPlace }
            let sameFrom = moves.filter { $0.from == from }
            if !sameFrom.isEmpty {
                return sameFrom.min { a, b in
                    a.to.manhattan(to: to) < b.to.manhattan(to: to)
                }
            }
            let recordedCapture = state.board[to.r][to.c] != nil
            let pool = recordedCapture
                ? (moves.filter { isCapture(state, $0) }.isEmpty ? moves : moves.filter { isCapture(state, $0) })
                : moves
            return pool.min { a, b in
                scoreDistance(a, from: from, to: to) < scoreDistance(b, from: from, to: to)
            }
        }
    }

    private func scoreDistance(_ move: Move, from: Coord, to: Coord) -> Int {
        let origin = move.from ?? move.to
        return origin.manhattan(to: from) * 2 + move.to.manhattan(to: to)
    }
}

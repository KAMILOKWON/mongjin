import Foundation

public let ortho: [(Int, Int)] = [(-1, 0), (1, 0), (0, -1), (0, 1)]
public let all8: [(Int, Int)] = ortho + [(-1, -1), (-1, 1), (1, -1), (1, 1)]

public func inBoard(_ n: Int, _ r: Int, _ c: Int) -> Bool {
    r >= 0 && r < n && c >= 0 && c < n
}

/// 흑은 아래(r = n-1)에서 시작해 위(r = 0)로, 백은 그 반대로 전진한다.
public func homeRow(player: Player, n: Int) -> Int {
    player == .black ? n - 1 : 0
}

public func goalRow(player: Player, n: Int) -> Int {
    player == .black ? 0 : n - 1
}

public func goalCells(for player: Player, config: RuleConfig) -> [Coord] {
    let n = config.boardSize
    let row = goalRow(player: player, n: n)
    let mid = n / 2
    switch config.goalCells {
    case .fullRow:
        return (0..<n).map { Coord(r: row, c: $0) }
    case .center3:
        return [mid - 1, mid, mid + 1].map { Coord(r: row, c: $0) }
    case .center1:
        return [Coord(r: row, c: mid)]
    }
}

public func isGoalCell(player: Player, coord: Coord, config: RuleConfig) -> Bool {
    goalCells(for: player, config: config).contains(coord)
}

public func isAnyGoalCell(_ coord: Coord, config: RuleConfig) -> Bool {
    isGoalCell(player: .black, coord: coord, config: config)
        || isGoalCell(player: .white, coord: coord, config: config)
}

public func initialState(_ config: RuleConfig = .default) -> GameState {
    let n = config.boardSize
    var board: [[Piece?]] = Array(repeating: Array(repeating: nil, count: n), count: n)
    let mid = n / 2
    board[homeRow(player: .black, n: n)][mid] = Piece(player: .black, type: .king)
    board[homeRow(player: .white, n: n)][mid] = Piece(player: .white, type: .king)
    var state = GameState(
        board: board,
        turn: .black,
        guardsInHand: [.black: config.guardCount, .white: config.guardCount],
        history: [],
        positionCounts: [:]
    )
    state.positionCounts[positionKey(state)] = 1
    return state
}

public func positionKey(_ state: GameState) -> String {
    let cells = state.board.map { row in
        row.map { piece -> String in
            guard let piece else { return "." }
            let ch = piece.type == .king ? "k" : "g"
            return piece.player == .black ? ch : ch.uppercased()
        }.joined()
    }.joined(separator: "/")
    let blackHand = state.guardsInHand[.black] ?? 0
    let whiteHand = state.guardsInHand[.white] ?? 0
    return "\(state.turn.rawValue)|\(blackHand),\(whiteHand)|\(cells)"
}

public func findKing(in state: GameState, player: Player) -> Coord? {
    let n = state.size
    for r in 0..<n {
        for c in 0..<n {
            if let piece = state.board[r][c], piece.type == .king, piece.player == player {
                return Coord(r: r, c: c)
            }
        }
    }
    return nil
}

private func placementCells(state: GameState, config: RuleConfig) -> [Coord] {
    let n = state.size
    let me = state.turn
    var out: [Coord] = []
    var seen = Set<Coord>()

    if config.placement == .ownHalf {
        let mid = n / 2
        for r in 0..<n {
            let inHalf = me == .black ? r > mid : r < mid
            guard inHalf else { continue }
            for c in 0..<n where state.board[r][c] == nil {
                out.append(Coord(r: r, c: c))
            }
        }
    } else {
        for r in 0..<n {
            for c in 0..<n {
                guard let piece = state.board[r][c], piece.player == me else { continue }
                for (dr, dc) in ortho {
                    let nr = r + dr
                    let nc = c + dc
                    guard inBoard(n, nr, nc), state.board[nr][nc] == nil else { continue }
                    let coord = Coord(r: nr, c: nc)
                    if seen.insert(coord).inserted {
                        out.append(coord)
                    }
                }
            }
        }
    }

    if config.noGuardOnGoal {
        return out.filter { !isAnyGoalCell($0, config: config) }
    }
    return out
}

private func pieceMoves(state: GameState, from: Coord, config: RuleConfig) -> [Move] {
    let n = state.size
    guard let piece = state.board[from.r][from.c] else { return [] }
    let me = piece.player
    var out: [Move] = []

    if piece.type == .king {
        for (dr, dc) in all8 {
            let r = from.r + dr
            let c = from.c + dc
            if inBoard(n, r, c), state.board[r][c] == nil {
                out.append(.move(from: from, to: Coord(r: r, c: c)))
            }
        }
        return out
    }

    // 호위는 목적지 세 칸에 들어가지 못한다.
    // 단, 그 칸에 상대 왕이 있으면 잡는 것은 예외로 허용한다.
    let canCapture: (Piece) -> Bool = { target in
        target.player != me && (target.type == .escort || config.kingCapture)
    }
    let guardCanStop: (Int, Int) -> Bool = { r, c in
        !config.noGuardOnGoal || !isAnyGoalCell(Coord(r: r, c: c), config: config)
    }
    let canLand: (Int, Int, Piece?) -> Bool = { r, c, target in
        if let target {
            return canCapture(target) && (target.type == .king || guardCanStop(r, c))
        }
        return guardCanStop(r, c)
    }

    for (dr, dc) in ortho {
        if config.guardMove == .step {
            let r = from.r + dr
            let c = from.c + dc
            guard inBoard(n, r, c) else { continue }
            if canLand(r, c, state.board[r][c]) {
                out.append(.move(from: from, to: Coord(r: r, c: c)))
            }
        } else {
            var r = from.r + dr
            var c = from.c + dc
            while inBoard(n, r, c) {
                let target = state.board[r][c]
                if canLand(r, c, target) {
                    out.append(.move(from: from, to: Coord(r: r, c: c)))
                }
                if target != nil { break }
                r += dr
                c += dc
            }
        }
    }
    return out
}

public func legalMoves(_ state: GameState, _ config: RuleConfig) -> [Move] {
    let n = state.size
    let me = state.turn
    var out: [Move] = []

    if (state.guardsInHand[me] ?? 0) > 0 {
        for to in placementCells(state: state, config: config) {
            out.append(.place(to: to))
        }
    }

    for r in 0..<n {
        for c in 0..<n {
            if let piece = state.board[r][c], piece.player == me {
                out.append(contentsOf: pieceMoves(state: state, from: Coord(r: r, c: c), config: config))
            }
        }
    }
    return out
}

public func isLegal(_ move: Move, in state: GameState, config: RuleConfig) -> Bool {
    legalMoves(state, config).contains(move)
}
